/** Identifies a GitHub PR overview and builds a canonical URL for GitHub CLI. */
export function parseGitHubPullRequestUrl(href: string): { number: number; url: string } | undefined {
  if (!/^https?:\/\//i.test(href)) return;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if (url.hostname !== 'github.com' || url.username || url.password || url.port) return;
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match) return;
  const [, owner, repo, id] = match;
  const number = Number(id);
  if (!Number.isSafeInteger(number)) return;
  return { number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}
