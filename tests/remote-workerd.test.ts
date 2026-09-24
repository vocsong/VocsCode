/** The remote-access flow end to end against the REAL relay Worker running locally in workerd —
 *  Worker entry and edge limits, Hub Durable Object with hibernatable sockets, real TCP
 *  WebSockets — driven by a real RemoteHost and RelayClient. Runs on every `npm test`; no account
 *  or network needed. The in-memory test relay shares the relay's route and routing code, but only
 *  this suite exercises the runtime itself: it is what found a refused request's unread body
 *  ending a `wrangler dev` session and a revocation answering 500 in production code. */
import { afterAll, beforeAll, it } from 'vitest';
import { startLocalRelay, type LocalRelay } from './support/local-relay';
import { remoteSmoke } from './support/remote-smoke';

let relay: LocalRelay;

beforeAll(async () => {
  relay = await startLocalRelay();
}, 60_000);

afterAll(async () => {
  await relay?.stop();
});

it('pairs, handshakes, invokes, shares the mirror key and revokes through the real Worker in workerd', async () => {
  await remoteSmoke({ origin: relay.origin, enrollToken: relay.enrollToken, revealErrors: true });
}, 120_000);
