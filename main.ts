// main.ts — the entrypoint lifecycle for the git-forge.
//
// app.ts holds the whole forge behind createApp(); this file only owns the
// trial lifecycle the suite expects from the process:
//
//   1. start the forge on an ephemeral port (the kernel picks it; the suite
//      owns 8080, so that port is never ours to take),
//   2. tell the suite where we landed: POST {"port": n} to
//      $MAKEFUN_ENV_URL/register — the suite dials back the address that
//      request came from,
//   3. ask $MAKEFUN_ENV_URL/done until it answers {"done": true}, which is
//      the suite saying its checks, its workloads and its export are over,
//   4. close the server and exit 0.
//
// Nothing here touches forge state, so nothing here can disturb the
// determinism app.ts promises: no timestamps, no randomness, only the port
// the kernel handed out, and that port never reaches a response body.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** How long to wait between two /done polls that answered "not yet". */
const DONE_POLL_PAUSE_MS = 200;
/** Pause between two registration attempts while the suite is still booting. */
const REGISTER_PAUSE_MS = 500;
/** Registration attempts before giving up: about a minute of patience. */
const REGISTER_ATTEMPTS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The suite's base URL, from the one environment variable that names it. */
function suiteBaseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  if (raw === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: nowhere to register with');
  }
  return raw.replace(/\/+$/, '');
}

/** POST our port to the suite, retrying while its listener is still coming up. */
async function registerWithSuite(base: string, port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    let refusedStatus: number | null = null;
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return;
      refusedStatus = response.status;
    } catch (err) {
      lastError = err;
    }
    if (refusedStatus !== null) {
      // A 4xx means the suite heard us and refused this exact payload;
      // sending the same body again for a minute cannot change its mind.
      if (refusedStatus >= 400 && refusedStatus < 500) {
        throw new Error(`register refused with HTTP ${refusedStatus}`);
      }
      lastError = new Error(`register answered HTTP ${refusedStatus}`);
    }
    if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_PAUSE_MS);
  }
  throw lastError instanceof Error ? lastError : new Error('register never succeeded');
}

/** Poll /done until the suite reports the trial finished; ride out hiccups. */
async function waitUntilSuiteIsDone(base: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const body: unknown = await response.json().catch(() => null);
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // The suite is mid-flight or restarting its listener; keep asking.
    }
    await sleep(DONE_POLL_PAUSE_MS);
  }
}

async function run(): Promise<void> {
  const base = suiteBaseUrl();
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address() as AddressInfo;
  process.stderr.write(`git-forge listening on port ${address.port}\n`);
  await registerWithSuite(base, address.port);
  await waitUntilSuiteIsDone(base);
  server.close();
  process.exit(0);
}

run().catch((err: unknown) => {
  process.stderr.write(`git-forge failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
