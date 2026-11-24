/** The retired web remote client lived at /app; the dashboard replaced it (docs/WEB-DASHBOARD.md).
 *  Released desktops still open `/app?connect=<hash>` for Connect with Vocs, so the query survives.
 *  A relative Location keeps the redirect on whatever origin the landing serves this from. */
export function legacyAppRedirect(url: URL): Response | null {
  if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return null;
  const rest = url.pathname.slice('/app'.length) || '/';
  return new Response(null, { status: 301, headers: { location: `/dashboard${rest}${url.search}`, 'cache-control': 'no-store' } });
}
