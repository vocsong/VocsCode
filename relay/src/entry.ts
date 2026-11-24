import { WorkerEntrypoint } from 'cloudflare:workers';
import { INTERNAL_ACCOUNT_ID_HEADER } from './account';
import { CONTROLLER_ASSERTION_HEADER, CONTROL_ASSERTION_TTL_MS, CONTROL_DISCOVERY_INTERNAL_PATH,
  controlDiscoveryPrincipalSchema, controlHttpError, controlJson, createDiscoveryAssertion, readControlBytes } from './control-auth';
import type { Env } from './worker';

export { default, EnrollmentDirectory, Hub } from './worker';

/** Sole consumer: the Hub's private, resource-bound OAuth gateway. No fetch handler, public
 * route, browser authority, shared Hub secret, or caller-selected relay host/route. */
export class ControlDiscovery extends WorkerEntrypoint<Env> {
  async discover(request: Request, identity: unknown): Promise<Response> {
    if (this.env.CONTROL_DISCOVERY_ENABLED !== '1') return controlJson({ error: 'not found' }, 404);
    const secret = this.env.ACCOUNT_ASSERTION_SECRET;
    if (!secret || new TextEncoder().encode(secret).byteLength < 32) return controlJson({ error: 'unavailable' }, 503);
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/vocs-code' || url.search || request.headers.has('upgrade')) {
        return controlJson({ error: 'invalid_request' }, 400);
      }
      const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
      if (type !== 'application/json' || (encoding !== undefined && encoding !== 'identity')) {
        return controlJson({ error: 'unsupported_media_type' }, 415);
      }
      const parsed = controlDiscoveryPrincipalSchema.safeParse(identity);
      const now = Date.now();
      if (!parsed.success || parsed.data.validUntil <= now || parsed.data.validUntil > now + CONTROL_ASSERTION_TTL_MS) {
        return controlJson({ error: 'invalid_controller_assertion' }, 401);
      }
      const principal = parsed.data;
      const body = await readControlBytes(request);
      const assertion = await createDiscoveryAssertion(principal, body, secret);
      if (request.signal.aborted || principal.validUntil <= Date.now()) return controlJson({ error: 'invalid_controller_assertion' }, 401);
      const headers = new Headers({
        [INTERNAL_ACCOUNT_ID_HEADER]: principal.accountId,
        [CONTROLLER_ASSERTION_HEADER]: assertion
      });
      for (const name of ['accept', 'content-type', 'mcp-protocol-version']) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const hub = this.env.HUB.get(this.env.HUB.idFromName(principal.accountId));
      return await hub.fetch(new Request(`https://hub${CONTROL_DISCOVERY_INTERNAL_PATH}`, { method: 'POST', headers, body, signal: request.signal }));
    } catch (error) { return controlHttpError(error); }
  }
}
