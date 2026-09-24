/** The real relay Worker (relay/wrangler.jsonc — Worker entry, Hub Durable Object, the static web
 *  app with its _headers, the rate-limit bindings) running locally in workerd through wrangler's
 *  programmatic dev server: the runtime `wrangler dev` uses, with a throwaway enrollment secret
 *  and state directory. No Cloudflare account, no network. Stopped through dispose(), never a
 *  process kill (a killed wrangler can corrupt its local config). */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unstable_startWorker } from 'wrangler';

const root = path.resolve(import.meta.dirname, '..', '..');

export interface LocalRelay {
  origin: string;
  enrollToken: string;
  stop(): Promise<void>;
}

export async function startLocalRelay(): Promise<LocalRelay> {
  const enrollToken = randomBytes(32).toString('base64url');
  const persist = await mkdtemp(path.join(os.tmpdir(), 'vocs-relay-state-'));
  const worker = await unstable_startWorker({
    config: path.join(root, 'relay', 'wrangler.jsonc'),
    bindings: { ENROLL_TOKEN: { type: 'plain_text', value: enrollToken } },
    dev: { server: { hostname: '127.0.0.1', port: 0 }, persist, inspector: false, watch: false, logLevel: 'error' }
  });
  await worker.ready;
  const url = await worker.url;
  return {
    origin: url.origin,
    enrollToken,
    stop: async () => {
      await worker.dispose();
      await rm(persist, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
