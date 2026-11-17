# git-forge-riegan

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rikyansyah/git-forge-riegan/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rikyansyah/git-forge-riegan/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A from-scratch GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL v4 and MCP in one Node 22 process, stdlib only.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=vrsa6rr4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards

# gitforge — a GitHub-compatible git forge

A from-scratch implementation of a GitHub-compatible forge for the
`github-core-clone-01` bounty on make.fun, written in TypeScript with Node 22
stdlib only: no dependencies, no git binary, no outside service.

## Surface

- **Git smart HTTP** at `/{owner}/{repo}.git`:
  `git-upload-pack` protocol v2 (advertisement, `ls-refs`, `fetch` with
  `thin-pack`/`ofs-delta`/`shallow`/`deepen`, acknowledgments with `ready`,
  sideband packfiles) and `git-receive-pack` v0 (create/update/delete refs,
  fast-forward enforcement, mixed ok/ng reports, sideband status). Packfiles
  are built and read by hand (PACK v2, plain objects, OFS/REF delta
  resolution on read); objects are SHA-1 over `"<type> <size>\0" + bytes`.
- **REST v3** at `/api/v3`: repos (create/get/patch/delete, pagination with
  `Link: rel="next"`), branches, git refs, commits, contents (PUT/DELETE with
  sha + 409 on stale sha), labels (an issue naming an unknown label is 422),
  issues + comments, pulls + squash merge with conflict detection (405).
  Every reply is JSON with a non-empty `X-GitHub-Request-Id`; errors are
  `{"message": ...}`; a missing/invalid bearer token is 401; a repo under
  another owner is 404, never 403.
- **GraphQL v4** at `/api/graphql`: `viewer`, `repository` (fields,
  connections with cursor pagination, `issue`/`pullRequest` by number),
  `node(id:)` with `... on Repository`, `__type` introspection, batch
  arrays, and the mutations `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`. Unknown fields are
  reported as errors (HTTP 200).
- **MCP** at `/mcp`: Streamable HTTP JSON-RPC 2.0 — `server/discover`
  (modern era 2026-07-28), `initialize`, `tools/list` (byte-identical on
  repeat calls), `tools/call` for `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`. Tools act on
  the same in-memory store as REST, so effects are visible over REST.
- `GET /healthz` answers `{"ok": true}`; anything else is 404
  `{"message": "Not Found"}`.

## Determinism

No wall clock and no unseeded randomness reach any state the suite reads:
commit timestamps come from a fixed epoch plus a counter, ids are
sequential counters, global ids are deterministic encodings of the object's
identity. Two runs on the same instance export byte-identical state.

## Layout

- `main.ts` — the entry lifecycle, as shipped in the kit starter:
  bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll
  `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, exit 0.
- `app.ts` — the whole forge (single file, ~1900 lines).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT) — as shipped in the kit
  starter.

## Local grade (practice trials)

```
cd <kit>
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-dir> --driver process --instances 3
```

Last local result (2026-11-17, Node v24.22.1, process driver):
trial 0: 952, trial 1: 939, trial 2: 937 — mean **942.7**
(feature 600/600, agent 200/200, perf 137–152), 120/120 conformance
checks, replay matched byte for byte on all three trials. The house
reference scores 600 + 200 + ~100 perf ≈ 900.
