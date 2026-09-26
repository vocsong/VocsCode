/** Offline transport only: production sees an approved GitHub-shaped URL, while the test
 * boundary routes that exact URL to real bare-Git effects. Never a production local→GitHub map. */
import { runCapture } from '../../src/main/runtime';

export const fixtureGitHubRemote = 'https://example.invalid/fixture/repository.git';
export const fixtureGitHubRepo = 'example.invalid/fixture/repository';

export function fixturePr(branch: string, head: string, base: string, number = 1) {
  return { number, url: `https://${fixtureGitHubRepo}/pull/${number}`, state: 'OPEN', headRefOid: head, headRefName: branch, baseRefName: base,
    headRepository: { nameWithOwner: 'fixture/repository' }, headRepositoryOwner: { login: 'fixture' }, isCrossRepository: false,
    mergeCommit: undefined as { oid: string } | undefined };
}

const capture = runCapture;
export function fixtureGitHubTransport(bareRemote: string) {
  return (file: string, args: string[], options: Parameters<typeof runCapture>[2]) => {
    let offset = 0;
    while (args[offset] === '-c') offset += 2;
    if (!['ls-remote', 'fetch', 'push'].includes(args[offset])) return capture(file, args, options);
    const endpoint = args.indexOf(fixtureGitHubRemote, offset + 1);
    if (endpoint < 0) throw new Error('Offline GitHub fixture refused an unapproved Git endpoint');
    return capture(file, [...args.slice(0, endpoint), bareRemote, ...args.slice(endpoint + 1)], options);
  };
}
