/** Credential-bearing, app-managed endpoints. Pure URL policy shared with the browser. */
const ENDPOINT_ERROR = 'Endpoint must use HTTPS (WSS for sockets); HTTP/WS is allowed only on localhost, 127.0.0.0/8 or [::1]. URLs must be absolute and contain no user information.';

/** Parse first: WHATWG normalizes IPv4 spellings and IPv6 compression before the loopback check.
 * No DNS lookup or suffix match: private LANs and lookalike localhost names are not exceptions.
 * Errors deliberately never include the supplied URL, which may contain credentials. */
export function assertEndpointUrl(input: string, transport: 'http' | 'ws' = 'http'): URL {
  let url: URL;
  try {
    if (typeof input !== 'string' || /[\s\\]/.test(input) || !/^[a-z]+:\/\/[^/]/i.test(input)) throw new Error();
    url = new URL(input);
    if (url.username || url.password || input.split(/[/?#]/)[2]?.includes('@')) throw new Error();
  } catch {
    throw new Error(ENDPOINT_ERROR);
  }
  const secure = transport === 'ws' ? 'wss:' : 'https:';
  const plain = transport === 'ws' ? 'ws:' : 'http:';
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== secure && !(url.protocol === plain && loopback)) throw new Error(ENDPOINT_ERROR);
  return url;
}

/** Convert only a validated HTTP relay URL; never use a textual scheme substitution on untrusted data. */
export function endpointSocketUrl(input: string): string {
  const url = assertEndpointUrl(input);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return assertEndpointUrl(url.href, 'ws').href;
}

/** Validate the actual SDK/request URL, including environment defaults and pagination URLs.
 * Redirects are never followed: even HTTPS redirects can lose auth or forward custom secret headers.
 * Wrap injected fetches too, so a test/browser dependency cannot bypass the dispatch boundary. */
export function credentialFetch(fetchImpl?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assertEndpointUrl(raw);
    const response = await (fetchImpl ?? globalThis.fetch)(input, { ...init, redirect: 'error' });
    if (response.status >= 300 && response.status < 400) throw new Error('Endpoint redirects are not allowed. Configure the final HTTPS endpoint directly.');
    return response;
  };
}
