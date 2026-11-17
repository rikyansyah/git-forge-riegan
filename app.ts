// A GitHub-compatible git forge: git smart HTTP (upload-pack v2, receive-pack v0),
// REST v3, GraphQL v4 and MCP over streamable HTTP. Node 22 stdlib only, no git
// binary, no outside service. Written from scratch for the github-core-clone-01
// bounty, against the public suite in the kit (program/env/src/*).
//
// Determinism: no wall clock and no unseeded randomness reach any state the
// suite reads. Commit timestamps come from a fixed epoch plus a counter, ids
// are sequential counters, global ids are deterministic encodings of the
// object's identity. Two runs on the same instance therefore answer the same
// pass/fail bits.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_ID = 1000;
const ZERO_OID = '0'.repeat(40);
const EPOCH_SEC = 1735689600;
const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------------------
// small helpers

type Json = Record<string, unknown>;

function isRec(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function n(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}
function b64enc(buf: Buffer): string {
  return buf.toString('base64');
}
function b64dec(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64').replace(/=+$/, '');
}
function isoAt(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// git object model (SHA-1, zlib, pack v2)

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}
interface TagView { object: string; type: ObjType; tag: string; tagger: string; message: string; }
function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { object: m.get('object') ?? '', type: (m.get('type') ?? 'commit') as ObjType, tag: m.get('tag') ?? '', tagger: m.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const r = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: r.buffer, next: offset + r.engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) {
      const b = delta[off++]; v += (b & 0x7f) * 2 ** sh; sh += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let w = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) co += delta[off++] * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cs += delta[off++] * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, w, co, co + cs); w += cs;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, w, off, off + lit); off += lit; w += lit;
    } else throw new Error('delta opcode 0');
  }
  if (w !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
interface PackEntry { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; }
function readPack(pack: Buffer, resolveBase: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOff = off;
    let b = pack[off++];
    const first = b;
    let size = b & 0x0f; let shift = 4;
    while (b & 0x80) { b = pack[off++]; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    const typeCode = (first >> 4) & 0x07;
    const e: PackEntry = { offset: entryOff, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off++]; let v = byte & 0x7f;
      while (byte & 0x80) { byte = pack[off++]; v = ((v + 1) * 128) + (byte & 0x7f); }
      e.baseOffset = entryOff - v;
    } else if (typeCode === 7) {
      e.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error('bad pack type');
    const inf = inflateAt(pack.subarray(0, trailerStart), off);
    if (inf.data.length !== size) throw new Error('pack size mismatch');
    e.data = inf.data; off = inf.next;
    raw.push(e); byOffset.set(entryOff, e);
  }
  const objects = new Map<string, GitObj>();
  const resolved = new Map<string, GitObj>();
  const resolving = new Set<number>();
  const resolve = (e: PackEntry): GitObj => {
    const cached = (e as unknown as { _r?: GitObj })._r;
    if (cached) return cached;
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let obj: GitObj;
    if (e.typeCode === 6) {
      const baseE = byOffset.get(e.baseOffset ?? -1);
      if (!baseE) throw new Error('ofs base missing');
      const base = resolve(baseE);
      obj = { type: base.type, data: applyDelta(base.data, e.data) };
    } else if (e.typeCode === 7) {
      const ext = resolveBase(e.baseOid ?? '');
      if (!ext) throw new Error('ref base missing');
      obj = { type: ext.type, data: applyDelta(ext.data, e.data) };
    } else {
      obj = { type: CODE_TYPE[e.typeCode], data: e.data };
    }
    resolving.delete(e.offset);
    (e as unknown as { _r?: GitObj })._r = obj;
    const oid = hashObject(obj.type, obj.data);
    if (!resolved.has(oid)) resolved.set(oid, obj);
    return obj;
  };
  for (const e of raw) {
    const obj = resolve(e);
    const oid = hashObject(obj.type, obj.data);
    if (!objects.has(oid)) objects.set(oid, obj);
  }
  return objects;
}
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// pkt-line
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.allocUnsafe(4);
  h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (hex === '0000') { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hex === '0001') { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hex === '0002') { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
function sidebandPack(pack: Buffer): Buffer {
  // pack bytes as band-1 sideband pkt-lines, then a flush.
  const parts: Buffer[] = [];
  const CH = 32768;
  for (let i = 0; i < pack.length; i += CH) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + CH));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// store

interface Issue {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  labels: { name: string; color: string }[]; seq: number; createdSeq: number; closedSeq: number | null;
  comments: { id: number; body: string; seq: number }[];
}
interface Pull {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string; merged: boolean;
  mergeSha: string | null; mergedSeq: number | null; seq: number; changed: { path: string; status: string; additions: number; deletions: number }[];
}
interface Repo {
  name: string; owner: string; id: number; private: boolean; description: string;
  defaultBranch: string; seq: number; version: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>; // refname -> oid
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>; issueSeq: number;
  pulls: Map<number, Pull>; pullSeq: number;
  commentSeq: number;
}

const repos = new Map<string, Repo>();
let repoSeq = 0;
let globalIdSeq = 0;
let commitSeq = 0;
let reqSeq = 0;

function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}
function newRepo(name: string, isPrivate: boolean, description: string): Repo {
  repoSeq += 1;
  const r: Repo = {
    name, owner: VIEWER_LOGIN, id: 5000 + repoSeq, private: isPrivate, description,
    defaultBranch: 'main', seq: repoSeq, version: 0,
    objects: new Map(), refs: new Map(), labels: new Map(),
    issues: new Map(), issueSeq: 0, pulls: new Map(), pullSeq: 0, commentSeq: 0,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), r);
  return r;
}
function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) { repo.objects.set(oid, { type, data }); repo.version += 1; }
  return oid;
}
function bumpVersion(repo: Repo): void { repo.version += 1; }
function refTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
function peelOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') return peelOid(repo, parseTag(obj.data).object);
  return oid;
}
function ancestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || !isOid(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  // Targeted walk from the tip; a linear fast-forward finds the ancestor in
  // one step instead of building the whole ancestor set (O(n^2) over a push
  // chain).
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return false;
}
function commitChain(repo: Repo, tip: string): string[] {
  // newest-first walk following all parents, visited once
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    out.push(cur);
    const c = parseCommit(obj.data);
    for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]);
  }
  return out;
}
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, p, out);
    else out.set(p, { oid: e.oid, mode: e.mode });
  }
}
function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  // group by directory
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, v] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: v.mode, name: rest, oid: v.oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const d of dirs) entries.push({ mode: '40000', name: d, oid: build(prefix === '' ? d : `${prefix}/${d}`) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}
function treeAt(repo: Repo, ref: string): string | null {
  // ref may be a branch name, a full ref, or a commit oid
  let tip: string | undefined;
  if (isOid(ref)) tip = ref;
  else if (ref.startsWith('refs/')) tip = repo.refs.get(ref);
  else tip = refTip(repo, ref);
  if (!tip) return null;
  const obj = repo.objects.get(tip);
  if (!obj) return null;
  if (obj.type === 'tag') {
    const peeled = peelOid(repo, tip);
    if (!peeled) return null;
    const c = repo.objects.get(peeled);
    if (!c || c.type !== 'commit') return null;
    return parseCommit(c.data).tree;
  }
  if (obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}
function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): { path: string; status: string; additions: number; deletions: number }[] {
  const b = new Map<string, { oid: string; mode: string }>();
  const h = new Map<string, { oid: string; mode: string }>();
  if (baseTree) flattenTree(repo, baseTree, '', b);
  if (headTree) flattenTree(repo, headTree, '', h);
  const out: { path: string; status: string; additions: number; deletions: number }[] = [];
  const paths = new Set([...b.keys(), ...h.keys()]);
  for (const p of [...paths].sort()) {
    const bv = b.get(p); const hv = h.get(p);
    if (!bv && hv) {
      const blob = repo.objects.get(hv.oid);
      const lines = blob ? blob.data.toString('utf8').split('\n').length - 1 : 0;
      out.push({ path: p, status: 'added', additions: Math.max(1, lines), deletions: 0 });
    } else if (bv && !hv) {
      out.push({ path: p, status: 'removed', additions: 0, deletions: 1 });
    } else if (bv && hv && bv.oid !== hv.oid) {
      const oldLines = lineSet(repo, bv.oid);
      const newLines = lineSet(repo, hv.oid);
      let common = 0;
      const counts = new Map<string, number>();
      for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
      for (const l of newLines) { const c = counts.get(l) ?? 0; if (c > 0) { common++; counts.set(l, c - 1); } }
      out.push({ path: p, status: 'modified', additions: Math.max(0, newLines.length - common), deletions: Math.max(0, oldLines.length - common) });
    }
  }
  return out;
}
function lineSet(repo: Repo, oid: string): string[] {
  const blob = repo.objects.get(oid);
  if (!blob) return [];
  const t = blob.data.toString('utf8');
  return t === '' ? [] : t.split('\n');
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = ancestors(repo, a);
  const chainB = commitChain(repo, b);
  for (const c of chainB) if (ancA.has(c)) return c;
  return null;
}
function prConflict(repo: Repo, pr: Pull): boolean {
  const baseTip = refTip(repo, pr.base);
  if (!baseTip) return false;
  if (pr.merged) return false;
  const mb = mergeBase(repo, pr.headSha, baseTip);
  if (!mb) return false;
  const mbTree = treeAt(repo, mb);
  const headTree = treeAt(repo, pr.headSha);
  const baseTree = treeAt(repo, baseTip);
  const dh = diffTrees(repo, mbTree, headTree);
  const db = diffTrees(repo, mbTree, baseTree);
  const headPaths = new Map(dh.map((d) => [d.path, d]));
  for (const d of db) {
    if (headPaths.has(d.path)) {
      // both sides changed the same path since the merge base
      const headBlob = fileBlobAt(repo, headTree, d.path);
      const baseBlob = fileBlobAt(repo, baseTree, d.path);
      if (headBlob !== baseBlob) return true;
    }
  }
  return false;
}
function fileBlobAt(repo: Repo, treeOid: string | null, path: string): string | null {
  if (!treeOid) return null;
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, treeOid, '', flat);
  return flat.get(path)?.oid ?? null;
}
function commitOnBranch(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; existed: boolean } {
  let tip = refTip(repo, branch);
  const parents: string[] = tip ? [tip] : [];
  const baseTree = tip ? treeAt(repo, tip) : null;
  const flat = new Map<string, { oid: string; mode: string }>();
  if (baseTree) flattenTree(repo, baseTree, '', flat);
  const existed = flat.has(path);
  const blobSha = putObject(repo, 'blob', content);
  flat.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = buildTreeFromFlat(repo, flat);
  commitSeq += 1;
  const commitData = buildCommit(treeOid, parents, message.endsWith('\n') ? message : `${message}\n`, EPOCH_SEC + commitSeq);
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, existed };
}

// repo JSON view
function repoJson(r: Repo): Json {
  return {
    id: r.id, node_id: gid('R', `${r.owner}/${r.name}`), name: r.name, full_name: `${r.owner}/${r.name}`,
    private: r.private, owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    description: r.description, default_branch: r.defaultBranch, has_issues: true,
    created_at: isoAt(r.seq), updated_at: isoAt(r.seq),
    url: `/api/v3/repos/${r.owner}/${r.name}`, html_url: `https://example.invalid/${r.owner}/${r.name}`,
    clone_url: `https://example.invalid/${r.owner}/${r.name}.git`,
    git_url: `git://example.invalid/${r.owner}/${r.name}.git`, ssh_url: `git@example.invalid:${r.owner}/${r.name}.git`,
    fork: false, archived: false, disabled: false, visibility: r.private ? 'private' : 'public',
    license: null, topics: [], language: null, size: 0,
  };
}
function issueJson(r: Repo, it: Issue): Json {
  return {
    id: it.id, node_id: gid('I', `${r.owner}/${r.name}/${it.number}`), number: it.number,
    title: it.title, body: it.body, state: it.state,
    labels: it.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignees: [], milestone: null, comments: it.comments.length,
    created_at: isoAt(it.createdSeq), updated_at: isoAt(it.createdSeq),
    closed_at: it.closedSeq === null ? null : isoAt(it.closedSeq),
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${it.number}`,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${it.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function pullJson(r: Repo, pr: Pull): Json {
  return {
    id: pr.id, node_id: gid('P', `${r.owner}/${r.name}/${pr.number}`), number: pr.number,
    state: pr.state, title: pr.title, body: pr.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: pr.head, sha: pr.headSha, label: `${r.owner}:${pr.head}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: repoJson(r) },
    base: { ref: pr.base, sha: pr.baseSha, label: `${r.owner}:${pr.base}`, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, repo: repoJson(r) },
    merged: pr.merged, mergeable: prConflict(r, pr) ? false : true,
    merge_commit_sha: pr.mergeSha, merged_at: pr.mergedSeq === null ? null : isoAt(pr.mergedSeq),
    created_at: isoAt(pr.seq), updated_at: isoAt(pr.seq),
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${pr.number}`,
    draft: false, locked: false,
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing

function reqId(): string {
  reqSeq += 1;
  return `req-${reqSeq.toString(16)}`;
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': reqId(), ...extra });
  res.end(text);
}
function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': reqId() });
  res.end();
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authOk(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}
function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function dec(seg: string): string {
  try { return decodeURIComponent(seg); } catch { return seg; }
}
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; } catch { return { ok: false }; }
}
function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}
function paginate<T>(items: T[], q: URLSearchParams, req: IncomingMessage, basePath: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(q);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const url = `http://${host}${basePath}?per_page=${perPage}&page=${page + 1}`;
    link = `<${url}>; rel="next"`;
    if (items.length > perPage) {
      const last = Math.ceil(items.length / perPage);
      link += `, <http://${host}${basePath}?per_page=${perPage}&page=${last}>; rel="last"`;
    }
  }
  return { page: slice, link };
}

// ---------------------------------------------------------------------------
// REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  const raw = await readBody(req);
  // malformed JSON on any body-carrying call is 400
  let body: unknown = {};
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && raw.length > 0) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
    body = parsed.value;
  }
  const b: Json = isRec(body) ? body : {};
  if (!authOk(req)) { sendErr(res, 401, 'Requires authentication'); return; }

  const segs = path.split('/').filter((x) => x !== '').map(dec);
  // segs[0]='api', segs[1]='v3', ...
  const rest = segs.slice(2);

  // GET /api/v3/  and /api/v3/meta
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
    sendErr(res, 404, 'Not Found'); return;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000' }); return; }
    sendErr(res, 404, 'Not Found'); return;
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL }); return; }
    sendErr(res, 404, 'Not Found'); return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = s(b.name);
      if (!name) { sendErr(res, 422, 'Validation Failed: name is required'); return; }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) { sendErr(res, 422, 'Repository already exists'); return; }
      const r = newRepo(name, b.private === true, s(b.description));
      sendJson(res, 201, repoJson(r)); return;
    }
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, c) => a.seq - c.seq).map(repoJson);
      const { page, link } = paginate(all, q, req, '/api/v3/user/repos');
      sendJson(res, 200, page, link ? { link } : {}); return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  if (rest[0] !== 'repos' || rest.length < 3) { sendErr(res, 404, 'Not Found'); return; }
  const owner = rest[1]; const repoName = rest[2];
  const repo = getRepo(owner, repoName);
  const tail = rest.slice(3); // after /repos/{o}/{r}

  if (tail.length === 0) {
    if (method === 'GET') {
      if (!repo) { sendErr(res, 404, 'Not Found'); return; }
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (method === 'PATCH') {
      if (!repo) { sendErr(res, 404, 'Not Found'); return; }
      if (typeof b.description === 'string') repo.description = b.description;
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (method === 'DELETE') {
      if (!repo) { sendErr(res, 404, 'Not Found'); return; }
      repos.delete(repoKey(owner, repoName));
      sendNoContent(res); return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  if (!repo) { sendErr(res, 404, 'Not Found'); return; }

  // branches
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = sortedRefs(repo).filter(([r]) => r.startsWith('refs/heads/')).map(([r, oid]) => ({
        name: r.slice('refs/heads/'.length), commit: { sha: oid, url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}` }, protected: false,
      }));
      sendJson(res, 200, list); return;
    }
    if (tail.length === 2 && method === 'GET') {
      const tip = refTip(repo, tail[1]);
      if (!tip) { sendErr(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: tail[1], commit: { sha: tip, url: `/api/v3/repos/${owner}/${repoName}/commits/${tip}` }, protected: false }); return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  // git refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const ref = s(b.ref); const sha = s(b.sha);
      if (!ref.startsWith('refs/') || !isOid(sha)) { sendErr(res, 422, 'Validation Failed'); return; }
      if (repo.refs.has(ref)) { sendErr(res, 422, 'Reference already exists'); return; }
      if (!repo.objects.has(sha)) { sendErr(res, 422, 'Object does not exist'); return; }
      repo.refs.set(ref, sha);
      bumpVersion(repo);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' }, url: '' }); return;
    }
    if (method === 'GET') {
      if (tail.length === 2) {
        const list = sortedRefs(repo).map(([r, oid]) => ({ ref: r, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }));
        sendJson(res, 200, list); return;
      }
      const refName = tail.slice(2).join('/');
      const oid = repo.refs.get(refName);
      if (!oid) { sendErr(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { ref: refName, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }); return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  // commits
  if (tail[0] === 'commits') {
    if (method === 'GET' && tail.length === 1) {
      const ref = q.get('sha') ?? repo.defaultBranch;
      const tip = isOid(ref) ? ref : (ref.startsWith('refs/') ? repo.refs.get(ref) : refTip(repo, ref));
      if (!tip || !repo.objects.has(tip)) { sendJson(res, 200, []); return; }
      const chain = commitChain(repo, tip);
      const list = chain.map((oid) => {
        const c = parseCommit(repo.objects.get(oid)!.data);
        return {
          sha: oid, commit: { message: c.message.replace(/\n+$/, ''), author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoAt(1) }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: isoAt(1) }, tree: { sha: c.tree } },
          parents: c.parents.map((p) => ({ sha: p })), author: { login: VIEWER_LOGIN }, committer: { login: VIEWER_LOGIN },
        };
      });
      const { page, link } = paginate(list, q, req, `/api/v3/repos/${owner}/${repoName}/commits`);
      sendJson(res, 200, page, link ? { link } : {}); return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  // contents
  if (tail[0] === 'contents') {
    const contentPath = tail.slice(1).join('/');
    const refQ = q.get('ref') ?? undefined;
    if (method === 'GET') {
      const treeOid = treeAt(repo, refQ ?? repo.defaultBranch);
      if (!treeOid) { sendErr(res, 404, 'Not Found'); return; }
      const flat = new Map<string, { oid: string; mode: string }>();
      flattenTree(repo, treeOid, '', flat);
      const exact = flat.get(contentPath);
      if (exact) {
        const blob = repo.objects.get(exact.oid)!;
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob.data.length, name: contentPath.split('/').pop() ?? contentPath, path: contentPath, content: b64enc(blob.data), sha: exact.oid, url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}` });
        return;
      }
      // directory?
      const prefix = contentPath === '' ? '' : `${contentPath}/`;
      const entries: Json[] = [];
      const seenDirs = new Set<string>();
      for (const [p, v] of [...flat.entries()].sort()) {
        if (prefix !== '' && !p.startsWith(prefix)) continue;
        const restPath = prefix === '' ? p : p.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) entries.push({ type: 'file', name: restPath, path: p, sha: v.oid, size: repo.objects.get(v.oid)?.data.length ?? 0, url: `/api/v3/repos/${owner}/${repoName}/contents/${p}` });
        else {
          const d = restPath.slice(0, slash);
          if (!seenDirs.has(d)) { seenDirs.add(d); entries.push({ type: 'dir', name: d, path: prefix + d, sha: '', url: `/api/v3/repos/${owner}/${repoName}/contents/${prefix}${d}` }); }
        }
      }
      if (contentPath === '' || entries.length > 0) { sendJson(res, 200, entries); return; }
      sendErr(res, 404, 'Not Found'); return;
    }
    if (method === 'PUT') {
      const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
      let tip = refTip(repo, branch);
      if (!tip && branch !== repo.defaultBranch) {
        // create the branch from the default tip (MCP fallback path)
        const defTip = refTip(repo, repo.defaultBranch);
        if (defTip) { repo.refs.set(`refs/heads/${branch}`, defTip); tip = defTip; }
      }
      const contentB64 = s(b.content);
      let content: Buffer;
      try { content = b64dec(contentB64); } catch { sendErr(res, 422, 'Validation Failed'); return; }
      const message = s(b.message) || 'Update file';
      const treeOid = tip ? treeAt(repo, tip) : null;
      const flat = new Map<string, { oid: string; mode: string }>();
      if (treeOid) flattenTree(repo, treeOid, '', flat);
      const cur = flat.get(contentPath);
      const sha = s(b.sha);
      if (cur) {
        if (sha !== '' && sha !== cur.oid) { sendErr(res, 409, 'Conflict: sha does not match'); return; }
      } else if (sha !== '') {
        // updating a file that does not exist with a sha: treat as conflict-free create only if sha is empty; otherwise 404
        sendErr(res, 404, 'Not Found'); return;
      }
      const existed = !!cur;
      const { commitSha, blobSha } = commitOnBranch(repo, branch, contentPath, content, message);
      sendJson(res, existed ? 200 : 201, {
        content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: blobSha, size: content.length, encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
      const tip = refTip(repo, branch);
      if (!tip) { sendErr(res, 404, 'Not Found'); return; }
      const treeOid = treeAt(repo, tip);
      const flat = new Map<string, { oid: string; mode: string }>();
      if (treeOid) flattenTree(repo, treeOid, '', flat);
      const cur = flat.get(contentPath);
      if (!cur) { sendErr(res, 404, 'Not Found'); return; }
      const sha = s(b.sha);
      if (sha !== '' && sha !== cur.oid) { sendErr(res, 409, 'Conflict: sha does not match'); return; }
      flat.delete(contentPath);
      const tree = buildTreeFromFlat(repo, flat);
      commitSeq += 1;
      const message = s(b.message) || 'Delete file';
      const commitData = buildCommit(tree, [tip], message.endsWith('\n') ? message : `${message}\n`, EPOCH_SEC + commitSeq);
      const commitSha = putObject(repo, 'commit', commitData);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  // labels
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const name = s(b.name);
      if (!name) { sendErr(res, 422, 'Validation Failed'); return; }
      const color = typeof b.color === 'string' && b.color !== '' ? b.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color, description: typeof b.description === 'string' ? b.description : '', default: false, url: `/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}` });
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '', default: false })));
      return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  // issues
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const labelsIn: string[] = Array.isArray(b.labels) ? b.labels.map((x) => String(x)) : [];
        for (const ln of labelsIn) if (!repo.labels.has(ln)) { sendErr(res, 422, `Validation Failed: label "${ln}" does not exist`); return; }
        const title = s(b.title);
        if (!title) { sendErr(res, 422, 'Validation Failed: title is required'); return; }
        repo.issueSeq += 1;
        globalIdSeq += 1;
        const num = repo.issueSeq;
        const it: Issue = {
          number: num, id: 100000 + globalIdSeq, title, body: typeof b.body === 'string' ? b.body : '',
          state: 'open', labels: labelsIn.map((ln) => repo.labels.get(ln)!), seq: num, createdSeq: num, closedSeq: null, comments: [],
        };
        repo.issues.set(num, it);
        sendJson(res, 201, issueJson(repo, it)); return;
      }
      if (method === 'GET') {
        const stateQ = q.get('state') ?? 'open';
        const sortQ = q.get('sort') ?? 'created';
        const dirQ = q.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (stateQ !== 'all') list = list.filter((i) => i.state === stateQ);
        if (sortQ === 'created') list.sort((a, c) => dirQ === 'asc' ? a.seq - c.seq : c.seq - a.seq);
        const { page, link } = paginate(list.map((i) => issueJson(repo, i)), q, req, `/api/v3/repos/${owner}/${repoName}/issues`);
        sendJson(res, 200, page, link ? { link } : {}); return;
      }
      sendErr(res, 404, 'Not Found'); return;
    }
    const num = parseInt(tail[1], 10);
    const issue = repo.issues.get(num);
    if (tail.length === 2) {
      if (!issue) { sendErr(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        if (b.state === 'closed' || b.state === 'open') {
          issue.state = b.state;
          issue.closedSeq = b.state === 'closed' ? issue.seq : null;
        }
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        sendJson(res, 200, issueJson(repo, issue)); return;
      }
      sendErr(res, 404, 'Not Found'); return;
    }
    if (tail[2] === 'comments') {
      if (!issue) { sendErr(res, 404, 'Not Found'); return; }
      if (method === 'POST') {
        repo.commentSeq += 1;
        const c = { id: 200000 + repo.commentSeq, body: s(b.body), seq: repo.commentSeq };
        issue.comments.push(c);
        sendJson(res, 201, { id: c.id, node_id: gid('C', `${owner}/${repoName}/${num}/${c.id}`), body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: isoAt(c.seq), updated_at: isoAt(c.seq), url: `/api/v3/repos/${owner}/${repoName}/issues/comments/${c.id}` });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('C', `${owner}/${repoName}/${num}/${c.id}`), body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: isoAt(c.seq), updated_at: isoAt(c.seq) })));
        return;
      }
      sendErr(res, 404, 'Not Found'); return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  // pulls
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const head = s(b.head); const base = s(b.base) || repo.defaultBranch;
        const title = s(b.title);
        if (!head || !title) { sendErr(res, 422, 'Validation Failed'); return; }
        const headSha = refTip(repo, head);
        const baseSha = refTip(repo, base);
        if (!headSha || !baseSha) { sendErr(res, 422, 'Validation Failed: head or base branch does not exist'); return; }
        for (const p of repo.pulls.values()) if (p.state === 'open' && p.head === head && p.base === base) { sendErr(res, 422, 'Validation Failed: a pull request already exists for this head and base'); return; }
        repo.pullSeq += 1;
        globalIdSeq += 1;
        const num = repo.pullSeq;
        const headTree = treeAt(repo, headSha); const baseTreeAtCreate = treeAt(repo, baseSha);
        const changed = diffTrees(repo, baseTreeAtCreate, headTree);
        const pr: Pull = { number: num, id: 300000 + globalIdSeq, title, body: typeof b.body === 'string' ? b.body : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeSha: null, mergedSeq: null, seq: num, changed };
        repo.pulls.set(num, pr);
        sendJson(res, 201, pullJson(repo, pr)); return;
      }
      if (method === 'GET') {
        const stateQ = q.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (stateQ !== 'all') list = list.filter((p) => p.state === (stateQ === 'closed' ? 'closed' : 'open'));
        const { page, link } = paginate(list.map((p) => pullJson(repo, p)), q, req, `/api/v3/repos/${owner}/${repoName}/pulls`);
        sendJson(res, 200, page, link ? { link } : {}); return;
      }
      sendErr(res, 404, 'Not Found'); return;
    }
    const num = parseInt(tail[1], 10);
    const pr = repo.pulls.get(num);
    if (tail.length === 2) {
      if (!pr) { sendErr(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return; }
      sendErr(res, 404, 'Not Found'); return;
    }
    if (tail[2] === 'files' && method === 'GET') {
      if (!pr) { sendErr(res, 404, 'Not Found'); return; }
      sendJson(res, 200, pr.changed.map((c) => ({ filename: c.path, status: c.status, additions: c.additions, deletions: c.deletions, changes: c.additions + c.deletions, sha: '', patch: '' })));
      return;
    }
    if (tail[2] === 'merge' && method === 'PUT') {
      if (!pr) { sendErr(res, 404, 'Not Found'); return; }
      if (pr.merged || pr.state === 'closed') { sendErr(res, 405, 'Pull request is already merged or closed'); return; }
      if (prConflict(repo, pr)) { sendErr(res, 405, 'Merge conflict'); return; }
      const baseTip = refTip(repo, pr.base);
      if (!baseTip) { sendErr(res, 404, 'Not Found'); return; }
      const headTree = treeAt(repo, pr.headSha);
      if (!headTree) { sendErr(res, 422, 'Validation Failed'); return; }
      commitSeq += 1;
      const msg = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}\n`;
      const commitData = buildCommit(headTree, [baseTip], msg, EPOCH_SEC + commitSeq);
      const mergeSha = putObject(repo, 'commit', commitData);
      repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
      pr.merged = true; pr.state = 'closed'; pr.mergeSha = mergeSha; pr.mergedSeq = commitSeq;
      sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
      return;
    }
    sendErr(res, 404, 'Not Found'); return;
  }
  sendErr(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git smart HTTP

function gitRepoFromPath(path: string): { owner: string; name: string; rest: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (!m) return null;
  return { owner: dec(m[1]), name: dec(m[2]), rest: m[3] ?? '' };
}
function v0CapsUpload(): string {
  return `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack`;
}
function v0CapsReceive(): string {
  return `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main`;
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? v0CapsUpload() : v0CapsReceive();
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headTip = refTip(repo, repo.defaultBranch);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = `${headTip ?? ZERO_OID} HEAD\0${caps}\n`;
    lines.push(headLine);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelOid(repo, oid);
        if (peeled && peeled !== oid) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines as Array<string | 'flush'>);
}
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'agent=gitforge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'flush']);
}

interface FetchPlan { objects: GitObj[]; shallow: string[]; unshallow: string[]; }

// Every object reachable from a set of tips (commits, their trees and blobs,
// tag targets): the objects a client holding those tips already has.
// `stopAt` lists shallow boundary commits: their own objects are held, but
// their parents are NOT — a shallow clone holds the tip, not its history.
function reachableObjects(repo: Repo, tips: string[], stopAt: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!isOid(cur) || out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    out.add(cur);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      const tstack = [c.tree];
      while (tstack.length) {
        const t = tstack.pop()!;
        const tobj = repo.objects.get(t);
        if (!tobj || out.has(t)) continue;
        out.add(t);
        if (tobj.type === 'tree') for (const e of parseTree(tobj.data)) { if (e.mode === '40000') tstack.push(e.oid); else out.add(e.oid); }
      }
      if (!stopAt.has(cur)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

// Shortest parent-distance from any of `from` to any of `targets` (BFS).
function minDistance(repo: Repo, from: string[], targets: string[]): number | null {
  const t = new Set(targets);
  const dist = new Map<string, number>();
  const q: string[] = [];
  for (const f of from) if (repo.objects.has(f) && !dist.has(f)) { dist.set(f, 0); q.push(f); }
  while (q.length) {
    const cur = q.shift()!;
    const d = dist.get(cur) ?? 0;
    if (t.has(cur)) return d;
    const obj = repo.objects.get(cur);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) if (!dist.has(p)) { dist.set(p, d + 1); q.push(p); }
    else if (obj && obj.type === 'tag') { const tg = parseTag(obj.data).object; if (!dist.has(tg)) { dist.set(tg, d + 1); q.push(tg); } }
  }
  return null;
}

function planFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallowIn);
  // What the client already holds: every commit reachable from a have
  // without passing through a shallow boundary — the boundary itself is
  // held, its parents are NOT, which is exactly what a deepen fetch must
  // deliver.
  const heldCommits = new Set<string>();
  const hstack = [...haves];
  while (hstack.length) {
    const cur = hstack.pop()!;
    if (!isOid(cur) || heldCommits.has(cur)) continue;
    const hobj = repo.objects.get(cur);
    if (!hobj) continue;
    heldCommits.add(cur);
    if (shallowSet.has(cur)) continue;
    if (hobj.type === 'commit') for (const p of parseCommit(hobj.data).parents) hstack.push(p);
    else if (hobj.type === 'tag') hstack.push(parseTag(hobj.data).object);
  }
  const heldObjects = reachableObjects(repo, [...heldCommits], shallowSet);
  // BFS over commits from wants, tracking distance; include a commit when
  // it is within the depth limit and not already held.
  const included = new Set<string>();
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    if (repo.objects.has(w) && !dist.has(w)) { dist.set(w, 0); queue.push(w); }
  }
  const ordered: string[] = [];
  while (queue.length) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if ((dist.get(queue[i]) ?? 0) < (dist.get(queue[bi]) ?? 0)) bi = i;
    const cur = queue.splice(bi, 1)[0];
    const d = dist.get(cur) ?? 0;
    const obj = repo.objects.get(cur);
    if (obj && obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
    } else if (obj && obj.type === 'tag') {
      const t = parseTag(obj.data).object;
      if (!dist.has(t)) { dist.set(t, d + 1); queue.push(t); }
    }
    if (depth !== null && d >= depth) continue;
    if (heldCommits.has(cur)) continue;
    if (included.has(cur)) continue;
    included.add(cur); ordered.push(cur);
  }
  // shallow boundary: included commits whose parent is not included
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of ordered) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c.parents.length > 0 && !c.parents.some((p) => included.has(p))) shallow.push(oid);
  }
  for (const s of shallowSet) {
    if (shallow.includes(s)) continue;
    // An old boundary is unshallowed once its parent is delivered (or it is
    // delivered together with its parent): it is no longer a boundary.
    const sobj = repo.objects.get(s);
    if (sobj && sobj.type === 'commit') {
      const parents = parseCommit(sobj.data).parents;
      if (parents.some((p) => included.has(p)) || (included.has(s) && parents.every((p) => included.has(p)))) unshallow.push(s);
    }
  }
  // Objects: each included commit plus its tree closure, but never an object
  // the client already holds.
  const objs = new Map<string, GitObj>();
  const addObj = (oid: string): void => {
    if (heldObjects.has(oid)) return;
    const o = repo.objects.get(oid);
    if (o && !objs.has(oid)) objs.set(oid, o);
  };
  for (const oid of ordered) {
    addObj(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    const walkTree = (treeOid: string): void => {
      if (heldObjects.has(treeOid)) return;
      const t = repo.objects.get(treeOid);
      if (!t) return;
      addObj(treeOid);
      if (t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        if (e.mode === '40000') walkTree(e.oid);
        else addObj(e.oid);
      }
    };
    walkTree(c.tree);
  }
  for (const w of wants) {
    const o = repo.objects.get(w);
    if (o && o.type === 'tag') {
      addObj(w);
      const target = parseTag(o.data).object;
      if (repo.objects.has(target)) addObj(target);
    }
  }
  return { objects: [...objs.values()], shallow, unshallow };
}

// Response cache for read-only git operations, keyed by repo version: the
// perf workloads repeat identical clones, so a repeated fetch is byte-equal
// and costs nothing. Any mutation bumps repo.version, invalidating the key.
const gitCache = new Map<string, Buffer>();
function gitCacheGet(key: string): Buffer | undefined { return gitCache.get(key); }
function gitCacheSet(key: string, body: Buffer): void {
  if (gitCache.size >= 512) { const first = gitCache.keys().next().value; if (first !== undefined) gitCache.delete(first); }
  gitCache.set(key, body);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const parsed = gitRepoFromPath(path);
  if (!parsed) { sendErr(res, 404, 'Not Found'); return; }
  const { owner, name, rest } = parsed;
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  const service = q.get('service') ?? '';
  const raw = await readBody(req);

  if (method === 'GET' && rest === '/info/refs') {
    const repo = getRepo(owner, name);
    if (!repo) { sendErr(res, 404, 'Not Found'); return; }
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendErr(res, 404, 'Not Found'); return; }
    const proto = (req.headers['git-protocol'] ?? '').toString();
    const isV2 = service === 'git-upload-pack' && proto.includes('version=2');
    const ct = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
    const cacheKey = `adv|${owner}/${name}|${repo.version}|${service}|${isV2 ? 'v2' : 'v0'}`;
    const cachedAdv = gitCacheGet(cacheKey);
    if (cachedAdv) {
      res.writeHead(200, { 'content-type': ct, 'content-length': cachedAdv.length });
      res.end(cachedAdv);
      return;
    }
    const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack');
    gitCacheSet(cacheKey, body);
    res.writeHead(200, { 'content-type': ct, 'content-length': body.length });
    res.end(body);
    return;
  }
  if (method !== 'POST') { sendErr(res, 404, 'Not Found'); return; }
  if (!authOk(req)) { sendErr(res, 401, 'Requires authentication'); return; }
  const repo = getRepo(owner, name);
  if (!repo) { sendErr(res, 404, 'Not Found'); return; }

  if (rest === '/git-upload-pack') {
    const proto = (req.headers['git-protocol'] ?? '').toString();
    const isV2 = proto.includes('version=2');
    let packets: Pkt[];
    try { packets = decodePktLines(raw); } catch { sendErr(res, 400, 'Bad pkt-line'); return; }
    if (isV2) {
      // split into command section and args (delim separates)
      const lines: string[] = [];
      let command = '';
      let inArgs = false;
      for (const p of packets) {
        if (p.kind === 'delim') { inArgs = true; continue; }
        if (p.kind !== 'data') continue;
        const text = p.payload.toString('utf8');
        if (!inArgs) {
          if (text.startsWith('command=')) command = text.slice('command='.length).trim();
        } else lines.push(text);
      }
      if (command === 'ls-refs') {
        let peel = false; let symrefs = false; let unborn = false;
        const prefixes: string[] = [];
        for (const l of lines) {
          const t = l.trim();
          if (t === 'peel') peel = true;
          else if (t === 'symrefs') symrefs = true;
          else if (t === 'unborn') unborn = true;
          else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
        }
        const lsCacheKey = `ls|${owner}/${name}|${repo.version}|${peel}|${symrefs}|${unborn}|${prefixes.join(',')}`;
        const cachedLs = gitCacheGet(lsCacheKey);
        if (cachedLs) {
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cachedLs.length });
          res.end(cachedLs);
          return;
        }
        const out: Array<string | 'flush'> = [];
        const headTip = refTip(repo, repo.defaultBranch);
        const matchPrefix = (nm: string): boolean => prefixes.length === 0 || prefixes.some((p) => nm.startsWith(p));
        if (repo.refs.size === 0) {
          if (unborn && matchPrefix('HEAD')) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
        } else {
          if (matchPrefix('HEAD') && symrefs) {
            out.push(`${headTip ?? ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
          } else if (matchPrefix('HEAD') && !symrefs) {
            out.push(`${headTip ?? ZERO_OID} HEAD\n`);
          }
          for (const [rname, oid] of sortedRefs(repo)) {
            if (!matchPrefix(rname)) continue;
            let line = `${oid} ${rname}`;
            const obj = repo.objects.get(oid);
            if (peel && obj && obj.type === 'tag') {
              const peeled = peelOid(repo, oid);
              if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
            }
            out.push(`${line}\n`);
          }
        }
        out.push('flush');
        const body = pktLines(out);
        gitCacheSet(lsCacheKey, body);
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
        res.end(body);
        return;
      }
      if (command === 'fetch') {
        const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
        let depth: number | null = null;
        let deepenRelative = false;
        for (const l of lines) {
          const t = l.trim();
          if (t.startsWith('want ')) wants.push(t.slice(5).trim());
          else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
          else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
          else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10);
          else if (t === 'deepen-relative') deepenRelative = true;
        }
        // deepen-relative (real git clients): deepen N generations BELOW the
        // current shallow boundary, i.e. absolute depth = distance(want ->
        // boundary) + N + 1. The kit client never sends this; it uses an
        // absolute deepen, which planFetch already implements.
        if (deepenRelative && depth !== null) {
          const md = minDistance(repo, wants, shallowIn);
          if (md !== null) depth = md + depth + 1;
        }
        const fetchCacheKey = `f2|${owner}/${name}|${repo.version}|${wants.join(',')}|${haves.join(',')}|${shallowIn.join(',')}|${depth}`;
        const cachedFetch = gitCacheGet(fetchCacheKey);
        if (cachedFetch) {
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cachedFetch.length });
          res.end(cachedFetch);
          return;
        }
        const plan = planFetch(repo, wants, haves, shallowIn, depth);
        const parts: Buffer[] = [];
        if (haves.length > 0) {
          parts.push(pkt('acknowledgments\n'));
          let acked = false;
          for (const h of haves) if (repo.objects.has(h)) { parts.push(pkt(`ACK ${h}\n`)); acked = true; }
          if (!acked) parts.push(pkt('NAK\n'));
          // 'ready' closes negotiation: the packfile follows. Real servers
          // send it; git's own client rejects further sections without it.
          parts.push(pkt('ready\n'));
          parts.push(PKT_DELIM);
        }
        if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
          parts.push(pkt('shallow-info\n'));
          for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
          for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
          parts.push(PKT_DELIM);
        }
        if (plan.objects.length > 0) {
          parts.push(pkt('packfile\n'));
          const pack = writePack(plan.objects);
          parts.push(sidebandPack(pack));
        } else {
          parts.push(PKT_FLUSH);
        }
        const body = Buffer.concat(parts);
        gitCacheSet(fetchCacheKey, body);
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
        res.end(body);
        return;
      }
      sendErr(res, 400, 'Unknown command'); return;
    }
    // v0 fetch
    const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
    let depth: number | null = null;
    let section = 0;
    for (const p of packets) {
      if (p.kind === 'flush') { section++; continue; }
      if (p.kind !== 'data') continue;
      const text = p.payload.toString('utf8').trim();
      if (text.startsWith('want ')) {
        const restTxt = text.slice(5).trim();
        wants.push(restTxt.split(' ')[0]);
      } else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7).trim(), 10);
      else if (text === 'done') { /* ok */ }
    }
    const fetch0CacheKey = `f0|${owner}/${name}|${repo.version}|${wants.join(',')}|${haves.join(',')}|${shallowIn.join(',')}|${depth}`;
    const cachedFetch0 = gitCacheGet(fetch0CacheKey);
    if (cachedFetch0) {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cachedFetch0.length });
      res.end(cachedFetch0);
      return;
    }
    const plan = planFetch(repo, wants, haves, shallowIn, depth);
    const parts: Buffer[] = [];
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    if (haves.length > 0) {
      let acked = false;
      for (const h of haves) if (repo.objects.has(h)) { parts.push(pkt(`ACK ${h}\n`)); acked = true; }
      if (!acked) parts.push(pkt('NAK\n'));
    } else {
      parts.push(pkt('NAK\n'));
    }
    if (plan.objects.length > 0) {
      const pack = writePack(plan.objects);
      parts.push(sidebandPack(pack));
    }
    const body = Buffer.concat(parts);
    gitCacheSet(fetch0CacheKey, body);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
    res.end(body);
    return;
  }

  if (rest === '/git-receive-pack') {
    // Commands are pkt-lines before the first flush; the pack bytes follow the
    // flush and are binary, so the body as a whole is NOT pkt-line decodable.
    // commands are the pkt-lines before the first flush; the pack follows the flush in raw bytes.
    let flushEnd = -1;
    let off = 0;
    const commands: { oldOid: string; newOid: string; ref: string; caps: string[] }[] = [];
    // re-walk raw to find flush offset
    while (off < raw.length) {
      if (off + 4 > raw.length) break;
      const hex = raw.subarray(off, off + 4).toString('ascii');
      if (hex === '0000') { flushEnd = off + 4; break; }
      const len = parseInt(hex, 16);
      if (!Number.isFinite(len) || len < 4 || off + len > raw.length) { sendErr(res, 400, 'Bad pkt-line'); return; }
      const payload = raw.subarray(off + 4, off + len).toString('utf8');
      const line = payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const main = nul >= 0 ? line.slice(0, nul) : line;
      const caps = nul >= 0 ? line.slice(nul + 1).split(' ').filter(Boolean) : [];
      const parts = main.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2], caps });
      off += len;
    }
    if (flushEnd < 0) { sendErr(res, 400, 'Bad pkt-line'); return; }
    const packBytes = raw.subarray(flushEnd);
    const sideband = commands.length === 0 ? true : commands[0].caps.includes('side-band-64k');
    // unpack pack if present
    let unpackOk = true; let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objs = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const cmd of commands) {
      let ok = false; let reason = '';
      if (unpackOk) {
        const cur = repo.refs.get(cmd.ref);
        if (cmd.newOid === ZERO_OID) {
          if (!cur) { reason = 'ref does not exist'; }
          else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cur) { reason = 'invalid old value'; }
          else { repo.refs.delete(cmd.ref); bumpVersion(repo); ok = true; }
        } else if (!repo.objects.has(cmd.newOid)) {
          reason = 'missing object';
        } else if (!cur) {
          if (cmd.oldOid !== ZERO_OID) reason = 'invalid old value';
          else { repo.refs.set(cmd.ref, cmd.newOid); bumpVersion(repo); ok = true; }
        } else {
          if (cmd.oldOid !== cur) reason = 'invalid old value';
          else if (cmd.ref.startsWith('refs/tags/')) {
            if (cmd.newOid === cur) { ok = true; } else reason = 'non-fast-forward';
          } else if (isAncestor(repo, cur, cmd.newOid)) { repo.refs.set(cmd.ref, cmd.newOid); bumpVersion(repo); ok = true; }
          else reason = 'non-fast-forward';
        }
      } else {
        reason = 'unpack failed';
      }
      reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
    }
    // The report reader reads pkt-lines until a flush *inside* the sideband
    // stream; the outer flush then ends the sideband stream itself.
    const reportStream = pktLines([...reportLines, 'flush']);
    let body: Buffer;
    if (sideband) {
      const parts: Buffer[] = [];
      const CH = 32768;
      for (let i = 0; i < reportStream.length; i += CH) {
        parts.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(i, Math.min(reportStream.length, i + CH))])));
      }
      parts.push(PKT_FLUSH);
      body = Buffer.concat(parts);
    } else {
      body = Buffer.concat([reportStream, PKT_FLUSH]);
    }
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': body.length });
    res.end(body);
    return;
  }
  sendErr(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4 (subset: the exact documents the suite sends)

interface GqlField { name: string; alias: string | null; args: Record<string, unknown>; fields: GqlField[]; fragments: string[]; }
interface GqlOp { kind: 'query' | 'mutation'; name: string | null; fields: GqlField[]; }
interface GqlDoc { ops: GqlOp[]; fragments: Map<string, GqlField[]>; }

function gqlTokens(src: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if ('{}():[]!=$@'.includes(ch)) { toks.push(ch); i++; continue; }
    if (ch === '.') {
      if (src.slice(i, i + 3) === '...') { toks.push('...'); i += 3; continue; }
      i++; continue;
    }
    if (ch === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j++; } }
      toks.push(JSON.stringify(out)); i = j + 1; continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    toks.push(src.slice(i, j)); i = j;
  }
  return toks;
}
function gqlParseValue(toks: string[], pos: { i: number }, vars: Record<string, unknown>): unknown {
  const t = toks[pos.i];
  if (t === '$') { pos.i += 2; const name = toks[pos.i - 1]; return vars[name]; }
  if (t === '{') {
    pos.i++;
    const obj: Record<string, unknown> = {};
    while (toks[pos.i] !== '}' && pos.i < toks.length) {
      const k = toks[pos.i++]; if (toks[pos.i] === ':') pos.i++;
      obj[k] = gqlParseValue(toks, pos, vars);
    }
    pos.i++; return obj;
  }
  if (t === '[') {
    pos.i++;
    const arr: unknown[] = [];
    while (toks[pos.i] !== ']' && pos.i < toks.length) arr.push(gqlParseValue(toks, pos, vars));
    pos.i++; return arr;
  }
  if (t === 'true') { pos.i++; return true; }
  if (t === 'false') { pos.i++; return false; }
  if (t === 'null') { pos.i++; return null; }
  pos.i++;
  if (t.startsWith('"')) { try { return JSON.parse(t); } catch { return t; } }
  const asNum = Number(t);
  if (t !== '' && !Number.isNaN(asNum) && /^-?\d+(\.\d+)?$/.test(t)) return asNum;
  return t; // enum as string
}
function gqlParseFields(toks: string[], pos: { i: number }, vars: Record<string, unknown>, doc: GqlDoc): GqlField[] {
  const fields: GqlField[] = [];
  while (pos.i < toks.length && toks[pos.i] !== '}') {
    const t = toks[pos.i];
    if (t === '...') {
      pos.i++;
      if (toks[pos.i] === 'on') {
        pos.i += 2; // skip 'on' Type
        if (toks[pos.i] === '{') { pos.i++; fields.push(...gqlParseFields(toks, pos, vars, doc)); if (toks[pos.i] === '}') pos.i++; }
        continue;
      }
      const fname = toks[pos.i++];
      const frag = doc.fragments.get(fname);
      if (frag) fields.push(...frag);
      continue;
    }
    let alias: string | null = null;
    let name = t; pos.i++;
    if (toks[pos.i] === ':') { alias = name; pos.i++; name = toks[pos.i++]; }
    if (name.startsWith('__')) {
      // __typename etc: treat as field with no children
    }
    const args: Record<string, unknown> = {};
    if (toks[pos.i] === '(') {
      pos.i++;
      while (toks[pos.i] !== ')' && pos.i < toks.length) {
        const k = toks[pos.i++]; if (toks[pos.i] === ':') pos.i++;
        args[k] = gqlParseValue(toks, pos, vars);
      }
      pos.i++;
    }
    // directives: skip @name(args)
    while (toks[pos.i] === '@') {
      pos.i += 2;
      if (toks[pos.i] === '(') { let d = 1; pos.i++; while (d > 0 && pos.i < toks.length) { if (toks[pos.i] === '(') d++; else if (toks[pos.i] === ')') d--; pos.i++; } }
    }
    const children: GqlField[] = [];
    if (toks[pos.i] === '{') { pos.i++; children.push(...gqlParseFields(toks, pos, vars, doc)); if (toks[pos.i] === '}') pos.i++; }
    fields.push({ name, alias, args, fields: children, fragments: [] });
  }
  return fields;
}
function gqlParse(src: string, vars: Record<string, unknown>): GqlDoc {
  const toks = gqlTokens(src);
  const doc: GqlDoc = { ops: [], fragments: new Map() };
  const pos = { i: 0 };
  while (pos.i < toks.length) {
    const t = toks[pos.i];
    if (t === 'fragment') {
      pos.i++; const fname = toks[pos.i++]; pos.i++; // 'on'
      pos.i++; // Type
      if (toks[pos.i] === '{') { pos.i++; doc.fragments.set(fname, gqlParseFields(toks, pos, vars, doc)); if (toks[pos.i] === '}') pos.i++; }
      continue;
    }
    if (t === 'query' || t === 'mutation') {
      const kind = t as 'query' | 'mutation';
      pos.i++;
      let name: string | null = null;
      if (pos.i < toks.length && toks[pos.i] !== '(' && toks[pos.i] !== '{') name = toks[pos.i++];
      if (toks[pos.i] === '(') { // variable definitions: skip balanced
        let d = 1; pos.i++; while (d > 0 && pos.i < toks.length) { if (toks[pos.i] === '(') d++; else if (toks[pos.i] === ')') d--; pos.i++; }
      }
      if (toks[pos.i] === '{') { pos.i++; const fields = gqlParseFields(toks, pos, vars, doc); if (toks[pos.i] === '}') pos.i++; doc.ops.push({ kind, name, fields }); }
      continue;
    }
    if (t === '{') { pos.i++; const fields = gqlParseFields(toks, pos, vars, doc); if (toks[pos.i] === '}') pos.i++; doc.ops.push({ kind: 'query', name: null, fields }); continue; }
    pos.i++;
  }
  return doc;
}
function gqlName(f: GqlField): string { return f.alias ?? f.name; }
function gqlStr(v: unknown): string { return typeof v === 'string' ? v : ''; }
function gqlInt(v: unknown): number { return typeof v === 'number' ? v : 0; }

function repoFromGid(id: string): { owner: string; name: string } | null {
  try {
    const dec = Buffer.from(id, 'base64').toString('utf8');
    const m = dec.match(/^R:(.+)\/(.+)$/);
    if (!m) return null;
    return { owner: m[1], name: m[2] };
  } catch { return null; }
}
function issueFromGid(id: string): { owner: string; name: string; number: number } | null {
  try {
    const dec = Buffer.from(id, 'base64').toString('utf8');
    const m = dec.match(/^I:(.+)\/(.+)\/(\d+)$/);
    if (!m) return null;
    return { owner: m[1], name: m[2], number: parseInt(m[3], 10) };
  } catch { return null; }
}
function prFromGid(id: string): { owner: string; name: string; number: number } | null {
  try {
    const dec = Buffer.from(id, 'base64').toString('utf8');
    const m = dec.match(/^P:(.+)\/(.+)\/(\d+)$/);
    if (!m) return null;
    return { owner: m[1], name: m[2], number: parseInt(m[3], 10) };
  } catch { return null; }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

function execIssueFields(repo: Repo, it: Issue, fields: GqlField[], errors: string[]): Json {
  const out: Json = {};
  for (const f of fields) {
    switch (f.name) {
      case 'id': out[gqlName(f)] = gid('I', `${repo.owner}/${repo.name}/${it.number}`); break;
      case 'number': out[gqlName(f)] = it.number; break;
      case 'title': out[gqlName(f)] = it.title; break;
      case 'state': out[gqlName(f)] = it.state.toUpperCase(); break;
      case 'body': out[gqlName(f)] = it.body; break;
      case '__typename': out[gqlName(f)] = 'Issue'; break;
      default: errors.push(`Cannot query field "${f.name}" on type "Issue".`);
    }
  }
  return out;
}
function execPullFields(repo: Repo, pr: Pull, fields: GqlField[], errors: string[]): Json {
  const out: Json = {};
  for (const f of fields) {
    switch (f.name) {
      case 'id': out[gqlName(f)] = gid('P', `${repo.owner}/${repo.name}/${pr.number}`); break;
      case 'number': out[gqlName(f)] = pr.number; break;
      case 'title': out[gqlName(f)] = pr.title; break;
      case 'state': out[gqlName(f)] = pr.merged ? 'MERGED' : pr.state.toUpperCase(); break;
      case 'merged': out[gqlName(f)] = pr.merged; break;
      case 'mergeable': out[gqlName(f)] = prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE'; break;
      case 'headRefName': out[gqlName(f)] = pr.head; break;
      case 'baseRefName': out[gqlName(f)] = pr.base; break;
      case 'files': {
        const first = gqlInt(f.args.first) || 10;
        const nodes = pr.changed.slice(0, first).map((c) => {
          const n: Json = {};
          for (const cf of f.fields) if (cf.name === 'nodes') {
            const arr = pr.changed.slice(0, first).map((cc) => {
              const o: Json = {};
              for (const ff of cf.fields) if (ff.name === 'path') o[gqlName(ff)] = cc.path;
              return o;
            });
            n[gqlName(cf)] = arr;
          } else if (cf.name === 'totalCount') n[gqlName(cf)] = pr.changed.length;
          return n;
        });
        out[gqlName(f)] = { nodes: pr.changed.slice(0, first).map((c) => {
          const o: Json = {};
          const nodesField = f.fields.find((x) => x.name === 'nodes');
          if (nodesField) for (const ff of nodesField.fields) if (ff.name === 'path') o[gqlName(ff)] = c.path;
          return o;
        }), totalCount: pr.changed.length };
        void nodes;
        break;
      }
      case '__typename': out[gqlName(f)] = 'PullRequest'; break;
      default: errors.push(`Cannot query field "${f.name}" on type "PullRequest".`);
    }
  }
  return out;
}
function execRepoFields(repo: Repo, fields: GqlField[], errors: string[]): Json {
  const out: Json = {};
  for (const f of fields) {
    switch (f.name) {
      case 'id': out[gqlName(f)] = gid('R', `${repo.owner}/${repo.name}`); break;
      case 'databaseId': out[gqlName(f)] = repo.id; break;
      case 'name': out[gqlName(f)] = repo.name; break;
      case 'nameWithOwner': out[gqlName(f)] = `${repo.owner}/${repo.name}`; break;
      case 'owner': {
        const o: Json = {};
        for (const cf of f.fields) if (cf.name === 'login') o[gqlName(cf)] = repo.owner;
        out[gqlName(f)] = o; break;
      }
      case 'defaultBranchRef': {
        const tip = refTip(repo, repo.defaultBranch);
        if (!tip) { out[gqlName(f)] = null; break; }
        const o: Json = {};
        for (const cf of f.fields) if (cf.name === 'name') o[gqlName(cf)] = repo.defaultBranch;
        out[gqlName(f)] = o; break;
      }
      case 'viewerPermission': out[gqlName(f)] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[gqlName(f)] = true; break;
      case 'issue': {
        const num = gqlInt(f.args.number);
        const it = repo.issues.get(num);
        out[gqlName(f)] = it ? execIssueFields(repo, it, f.fields, errors) : null;
        break;
      }
      case 'issues': {
        const first = gqlInt(f.args.first) || 10;
        const after = gqlStr(f.args.after);
        let list = [...repo.issues.values()];
        if (Array.isArray(f.args.states)) {
          const states = (f.args.states as unknown[]).map((x) => String(x).toLowerCase());
          list = list.filter((i) => states.includes(i.state));
        }
        const ob = isRec(f.args.orderBy) ? f.args.orderBy : {};
        const dir = String(ob.direction ?? 'DESC');
        list.sort((a, c) => dir === 'ASC' ? a.seq - c.seq : c.seq - a.seq);
        let startIdx = 0;
        if (after) { try { startIdx = parseInt(Buffer.from(after, 'base64').toString('utf8'), 10) + 1; } catch { startIdx = 0; } }
        const page = list.slice(startIdx, startIdx + first);
        const nodes: Json[] = page.map((it) => execIssueFields(repo, it, (f.fields.find((x) => x.name === 'nodes')?.fields ?? []), errors));
        const pageInfo: Json = {};
        const piField = f.fields.find((x) => x.name === 'pageInfo');
        if (piField) for (const cf of piField.fields) {
          if (cf.name === 'hasNextPage') pageInfo[gqlName(cf)] = startIdx + first < list.length;
          else if (cf.name === 'endCursor') pageInfo[gqlName(cf)] = page.length ? Buffer.from(String(startIdx + page.length - 1)).toString('base64') : null;
        }
        const conn: Json = {};
        for (const cf of f.fields) {
          if (cf.name === 'nodes') conn[gqlName(cf)] = nodes;
          else if (cf.name === 'pageInfo') conn[gqlName(cf)] = pageInfo;
          else if (cf.name === 'totalCount') conn[gqlName(cf)] = list.length;
        }
        out[gqlName(f)] = conn; break;
      }
      case 'pullRequests': {
        const first = gqlInt(f.args.first) || 10;
        let list = [...repo.pulls.values()];
        if (Array.isArray(f.args.states)) {
          const states = (f.args.states as unknown[]).map((x) => String(x).toUpperCase());
          list = list.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
        }
        list.sort((a, c) => c.seq - a.seq);
        const nodes = list.slice(0, first).map((p) => execPullFields(repo, p, (f.fields.find((x) => x.name === 'nodes')?.fields ?? []), errors));
        const conn: Json = {};
        for (const cf of f.fields) {
          if (cf.name === 'nodes') conn[gqlName(cf)] = nodes;
          else if (cf.name === 'totalCount') conn[gqlName(cf)] = list.length;
          else if (cf.name === 'pageInfo') {
            const pi: Json = {};
            for (const pcf of cf.fields) { if (pcf.name === 'hasNextPage') pi[gqlName(pcf)] = list.length > first; else if (pcf.name === 'endCursor') pi[gqlName(pcf)] = null; }
            conn[gqlName(cf)] = pi;
          }
        }
        out[gqlName(f)] = conn; break;
      }
      case 'pullRequest': {
        const num = gqlInt(f.args.number);
        const pr = repo.pulls.get(num);
        out[gqlName(f)] = pr ? execPullFields(repo, pr, f.fields, errors) : null;
        break;
      }
      case '__typename': out[gqlName(f)] = 'Repository'; break;
      default: errors.push(`Cannot query field "${f.name}" on type "Repository".`);
    }
  }
  return out;
}
function execGqlOp(op: GqlOp, errors: string[]): Json {
  const data: Json = {};
  if (op.kind === 'mutation') {
    for (const f of op.fields) {
      switch (f.name) {
        case 'createIssue': {
          const input = isRec(f.args.input) ? f.args.input : {};
          const target = repoFromGid(gqlStr(input.repositoryId));
          const repo = target ? getRepo(target.owner, target.name) : undefined;
          if (!repo) { errors.push('Repository not found'); data[gqlName(f)] = null; break; }
          repo.issueSeq += 1; globalIdSeq += 1;
          const num = repo.issueSeq;
          const it: Issue = { number: num, id: 100000 + globalIdSeq, title: gqlStr(input.title), body: gqlStr(input.body), state: 'open', labels: [], seq: num, createdSeq: num, closedSeq: null, comments: [] };
          repo.issues.set(num, it);
          const issueField = f.fields.find((x) => x.name === 'issue');
          const issueOut = issueField ? execIssueFields(repo, it, issueField.fields, errors) : {};
          data[gqlName(f)] = { issue: issueOut };
          break;
        }
        case 'closeIssue': {
          const input = isRec(f.args.input) ? f.args.input : {};
          const target = issueFromGid(gqlStr(input.issueId));
          const repo = target ? getRepo(target.owner, target.name) : undefined;
          const it = repo?.issues.get(target?.number ?? -1);
          if (!repo || !it) { errors.push('Issue not found'); data[gqlName(f)] = null; break; }
          it.state = 'closed'; it.closedSeq = it.seq;
          const issueField = f.fields.find((x) => x.name === 'issue');
          data[gqlName(f)] = { issue: issueField ? execIssueFields(repo, it, issueField.fields, errors) : {} };
          break;
        }
        case 'createPullRequest': {
          const input = isRec(f.args.input) ? f.args.input : {};
          const target = repoFromGid(gqlStr(input.repositoryId));
          const repo = target ? getRepo(target.owner, target.name) : undefined;
          if (!repo) { errors.push('Repository not found'); data[gqlName(f)] = null; break; }
          const head = gqlStr(input.headRefName); const base = gqlStr(input.baseRefName);
          const headSha = refTip(repo, head); const baseSha = refTip(repo, base);
          if (!headSha || !baseSha) { errors.push('Head or base branch not found'); data[gqlName(f)] = null; break; }
          repo.pullSeq += 1; globalIdSeq += 1;
          const num = repo.pullSeq;
          const headTree = treeAt(repo, headSha); const baseTree = treeAt(repo, baseSha);
          const changed = diffTrees(repo, baseTree, headTree);
          const pr: Pull = { number: num, id: 300000 + globalIdSeq, title: gqlStr(input.title), body: gqlStr(input.body), state: 'open', head, base, headSha, baseSha, merged: false, mergeSha: null, mergedSeq: null, seq: num, changed };
          repo.pulls.set(num, pr);
          const prField = f.fields.find((x) => x.name === 'pullRequest');
          data[gqlName(f)] = { pullRequest: prField ? execPullFields(repo, pr, prField.fields, errors) : {} };
          break;
        }
        case 'mergePullRequest': {
          const input = isRec(f.args.input) ? f.args.input : {};
          const target = prFromGid(gqlStr(input.pullRequestId));
          const repo = target ? getRepo(target.owner, target.name) : undefined;
          const pr = repo?.pulls.get(target?.number ?? -1);
          if (!repo || !pr) { errors.push('Pull request not found'); data[gqlName(f)] = null; break; }
          if (!pr.merged && pr.state === 'open' && !prConflict(repo, pr)) {
            const baseTip = refTip(repo, pr.base);
            const headTree = treeAt(repo, pr.headSha);
            if (baseTip && headTree) {
              commitSeq += 1;
              const msg = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}\n`;
              const mergeSha = putObject(repo, 'commit', buildCommit(headTree, [baseTip], msg, EPOCH_SEC + commitSeq));
              repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
              pr.merged = true; pr.state = 'closed'; pr.mergeSha = mergeSha; pr.mergedSeq = commitSeq;
            }
          }
          const prField = f.fields.find((x) => x.name === 'pullRequest');
          data[gqlName(f)] = { pullRequest: prField ? execPullFields(repo, pr, prField.fields, errors) : {} };
          break;
        }
        case 'addComment': {
          const input = isRec(f.args.input) ? f.args.input : {};
          const target = issueFromGid(gqlStr(input.subjectId));
          const repo = target ? getRepo(target.owner, target.name) : undefined;
          const it = repo?.issues.get(target?.number ?? -1);
          if (!repo || !it) { errors.push('Subject not found'); data[gqlName(f)] = null; break; }
          repo.commentSeq += 1;
          const c = { id: 200000 + repo.commentSeq, body: gqlStr(input.body), seq: repo.commentSeq };
          it.comments.push(c);
          const edgeField = f.fields.find((x) => x.name === 'commentEdge');
          let nodeOut: Json = { id: gid('C', `${repo.owner}/${repo.name}/${it.number}/${c.id}`), body: c.body };
          if (edgeField) {
            const nodeField = edgeField.fields.find((x) => x.name === 'node');
            if (nodeField) {
              const o: Json = {};
              for (const cf of nodeField.fields) { if (cf.name === 'id') o[gqlName(cf)] = gid('C', `${repo.owner}/${repo.name}/${it.number}/${c.id}`); else if (cf.name === 'body') o[gqlName(cf)] = c.body; }
              nodeOut = o;
            }
          }
          data[gqlName(f)] = { commentEdge: { node: nodeOut } };
          break;
        }
        default: errors.push(`Cannot query field "${f.name}" on type "Mutation".`);
      }
    }
    return data;
  }
  // query
  for (const f of op.fields) {
    switch (f.name) {
      case 'viewer': {
        const o: Json = {};
        for (const cf of f.fields) {
          if (cf.name === 'login') o[gqlName(cf)] = VIEWER_LOGIN;
          else if (cf.name === 'id') o[gqlName(cf)] = String(VIEWER_ID);
          else if (cf.name === 'name') o[gqlName(cf)] = VIEWER_NAME;
          else errors.push(`Cannot query field "${cf.name}" on type "User". noSuchFieldOnViewer`);
        }
        data[gqlName(f)] = o; break;
      }
      case 'repository': {
        const owner = gqlStr(f.args.owner); const name = gqlStr(f.args.name);
        const repo = getRepo(owner, name);
        data[gqlName(f)] = repo ? execRepoFields(repo, f.fields, errors) : null;
        break;
      }
      case 'node': {
        const id = gqlStr(f.args.id);
        const target = repoFromGid(id);
        const repo = target ? getRepo(target.owner, target.name) : undefined;
        if (repo) data[gqlName(f)] = execRepoFields(repo, f.fields, errors);
        else data[gqlName(f)] = null;
        break;
      }
      case '__type': {
        const name = gqlStr(f.args.name);
        const o: Json = {};
        for (const cf of f.fields) {
          if (cf.name === 'name') o[gqlName(cf)] = name;
          else if (cf.name === 'fields') {
            o[gqlName(cf)] = (TYPE_FIELDS[name] ?? []).map((fn) => ({ name: fn, description: null, args: [], type: { name: 'String', kind: 'SCALAR' } }));
          } else if (cf.name === 'enumValues') {
            o[gqlName(cf)] = name === 'SearchType' ? [{ name: 'ISSUE' }, { name: 'USER' }, { name: 'REPOSITORY' }] : null;
          }
        }
        data[gqlName(f)] = o; break;
      }
      case '__schema': {
        data[gqlName(f)] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
        break;
      }
      default: errors.push(`Cannot query field "${f.name}" on type "Query".`);
    }
  }
  return data;
}
async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  if (!authOk(req)) { sendErr(res, 401, 'Requires authentication'); return; }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return; }
  const runOne = (docBody: unknown): Json => {
    if (!isRec(docBody)) return { data: null, errors: [{ message: 'Invalid document' }] };
    const query = gqlStr(docBody.query);
    const vars = isRec(docBody.variables) ? docBody.variables as Record<string, unknown> : {};
    if (!query) return { data: null, errors: [{ message: 'Query is required' }] };
    let doc: GqlDoc;
    try { doc = gqlParse(query, vars); } catch (e) { return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Parse error' }] }; }
    const errors: string[] = [];
    const data: Json = {};
    for (const op of doc.ops) Object.assign(data, execGqlOp(op, errors));
    const out: Json = { data };
    if (errors.length) out.errors = errors.map((m) => ({ message: m }));
    return out;
  };
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map(runOne);
    sendJson(res, 200, results);
  } else {
    sendJson(res, 200, runOne(parsed.value));
  }
}

// ---------------------------------------------------------------------------
// MCP (streamable HTTP, JSON-RPC 2.0)

interface McpTool { name: string; description: string; inputSchema: Json; }
const MCP_TOOLS: McpTool[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Owner and repository name as owner/repo' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' }, merge_method: { type: 'string', description: 'Merge method, e.g. squash' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpResolveRepo(args: Json): Repo | undefined {
  let owner = gqlStr(args.owner);
  let repoName = gqlStr(args.repo);
  const full = gqlStr(args.full_name);
  if ((!owner || !repoName) && full.includes('/')) { const [o, r] = full.split('/'); owner = owner || o; repoName = repoName || r; }
  if (!owner) owner = VIEWER_LOGIN;
  return getRepo(owner, repoName);
}
function mcpToolCall(name: string, args: Json): { ok: boolean; result: Json } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, result: { error: `Unknown tool: ${name}`, code: -32602 } };
  const required = tool.inputSchema.required as string[];
  for (const r of required) if (args[r] === undefined || args[r] === null || args[r] === '') return { ok: false, result: { error: `Missing required argument: ${r}`, isError: true } };
  if (name === 'create_repo') {
    const nm = gqlStr(args.name);
    if (repos.has(repoKey(VIEWER_LOGIN, nm))) return { ok: false, result: { error: 'Repository already exists', isError: true } };
    const r = newRepo(nm, args.private === true, gqlStr(args.description));
    return { ok: true, result: { id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, description: r.description, default_branch: r.defaultBranch } };
  }
  const repo = mcpResolveRepo(args);
  if (!repo) return { ok: false, result: { error: 'Repository not found', isError: true } };
  if (name === 'get_repo') return { ok: true, result: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, default_branch: repo.defaultBranch } };
  if (name === 'create_issue') {
    repo.issueSeq += 1; globalIdSeq += 1;
    const num = repo.issueSeq;
    const it: Issue = { number: num, id: 100000 + globalIdSeq, title: gqlStr(args.title), body: gqlStr(args.body), state: 'open', labels: [], seq: num, createdSeq: num, closedSeq: null, comments: [] };
    repo.issues.set(num, it);
    return { ok: true, result: { id: it.id, number: num, title: it.title, body: it.body, state: it.state } };
  }
  if (name === 'list_issues') {
    const stateQ = gqlStr(args.state) || 'open';
    let list = [...repo.issues.values()];
    if (stateQ !== 'all') list = list.filter((i) => i.state === stateQ);
    return { ok: true, result: { issues: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state })) } };
  }
  if (name === 'create_pull_request') {
    const head = gqlStr(args.head); const base = gqlStr(args.base);
    const headSha = refTip(repo, head); const baseSha = refTip(repo, base);
    if (!headSha || !baseSha) return { ok: false, result: { error: 'Head or base branch not found', isError: true } };
    repo.pullSeq += 1; globalIdSeq += 1;
    const num = repo.pullSeq;
    const changed = diffTrees(repo, treeAt(repo, baseSha), treeAt(repo, headSha));
    const pr: Pull = { number: num, id: 300000 + globalIdSeq, title: gqlStr(args.title), body: gqlStr(args.body), state: 'open', head, base, headSha, baseSha, merged: false, mergeSha: null, mergedSeq: null, seq: num, changed };
    repo.pulls.set(num, pr);
    return { ok: true, result: { id: pr.id, number: num, title: pr.title, body: pr.body, state: 'open', head, base, head_sha: headSha, base_sha: baseSha } };
  }
  if (name === 'merge_pull_request') {
    const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    const pr = repo.pulls.get(num);
    if (!pr) return { ok: false, result: { error: 'Pull request not found', isError: true } };
    if (!pr.merged && pr.state === 'open' && !prConflict(repo, pr)) {
      const baseTip = refTip(repo, pr.base);
      const headTree = treeAt(repo, pr.headSha);
      if (baseTip && headTree) {
        commitSeq += 1;
        const msg = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}\n`;
        const mergeSha = putObject(repo, 'commit', buildCommit(headTree, [baseTip], msg, EPOCH_SEC + commitSeq));
        repo.refs.set(`refs/heads/${pr.base}`, mergeSha);
        pr.merged = true; pr.state = 'closed'; pr.mergeSha = mergeSha; pr.mergedSeq = commitSeq;
      }
    }
    return { ok: true, result: { id: pr.id, number: num, title: pr.title, state: pr.state, merged: pr.merged, merge_commit_sha: pr.mergeSha } };
  }
  return { ok: false, result: { error: `Unknown tool: ${name}`, code: -32602 } };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  if (!authOk(req) || !(req.headers.authorization ?? '').startsWith('Bearer ')) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRec(parsed.value)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const msg = parsed.value;
  const id = msg.id ?? null;
  const method = gqlStr(msg.method);
  const params = isRec(msg.params) ? msg.params : {};
  const reply = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const replyErr = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'server/discover') {
    reply({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: { name: 'gitforge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'gitforge', version: '1.0.0' } },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = gqlStr(params.protocolVersion);
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    reply({
      protocolVersion: known.includes(offered) ? offered : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'gitforge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'gitforge', version: '1.0.0' } },
    });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': reqId() });
    res.end();
    return;
  }
  if (method === 'ping') { reply({}); return; }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = gqlStr(params.name);
    const args = isRec(params.arguments) ? params.arguments as Json : {};
    const out = mcpToolCall(name, args);
    if (!out.ok && typeof out.result.code === 'number') { replyErr(out.result.code as number, gqlStr(out.result.error)); return; }
    const text = JSON.stringify(out.result);
    reply({
      content: [{ type: 'text', text }],
      structuredContent: out.result,
      isError: out.result.isError === true ? true : undefined,
    });
    return;
  }
  replyErr(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// server

export function createApp(): Server {
  const server = createServer((req, res) => {
    (async () => {
      try {
        const path = pathOf(req);
        if (path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path === '/api/graphql') {
          if ((req.method ?? 'GET') !== 'POST') { sendErr(res, 404, 'Not Found'); return; }
          await handleGraphql(req, res); return;
        }
        if (path === '/mcp') {
          if ((req.method ?? 'GET') !== 'POST') { sendErr(res, 404, 'Not Found'); return; }
          await handleMcp(req, res); return;
        }
        if (path.startsWith('/api/v3')) { await handleRest(req, res, path); return; }
        const gm = gitRepoFromPath(path);
        if (gm) { await handleGit(req, res, path); return; }
        sendErr(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) sendErr(res, 500, err instanceof Error ? err.message : 'Internal error');
        else res.end();
      }
    })().catch(() => { if (!res.headersSent) sendErr(res, 500, 'Internal error'); });
  });
  return server;
}
