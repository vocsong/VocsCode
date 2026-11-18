/** The only release writer: validate everything, resume a draft, then expose the complete set. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCompleteSet, validateIdentity, hashFile } from './release-artifacts.mjs';

const markerPrefix = '<!-- vocs-release-provenance:';
export function provenanceMarker(identity) {
  validateIdentity(identity);
  return `${markerPrefix}${JSON.stringify({ tag: identity.tag, sha: identity.sha, version: identity.version })} -->`;
}

function checkMarker(release, identity, required = true) {
  const body = release.body ?? '';
  const occurrences = body.split(markerPrefix).length - 1;
  const marker = provenanceMarker(identity);
  if (occurrences === 0 && !required) return false;
  if (occurrences !== 1 || !body.includes(marker)) throw new Error('Release verified-SHA provenance is missing or different; refusing to change it.');
  return true;
}

const immutableError = () => new Error('Public release assets differ: immutable release; use a new version or a separately authorized repair (no repair override here).');

async function matches(github, remote, local) {
  if (remote.state !== 'uploaded' || remote.size !== local.size) return false;
  if (typeof remote.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(remote.digest)) return remote.digest === `sha256:${local.sha256}`;
  // Older GitHub assets have no digest. Hash the authenticated asset stream, never buffer installers.
  const downloaded = await github.hashAsset(remote.id);
  return downloaded.size === local.size && downloaded.sha256 === local.sha256;
}

async function exactRemote(github, release, assets) {
  const remote = await github.listAssets(release.id);
  if (remote.length !== assets.length || new Set(remote.map((asset) => asset.name)).size !== remote.length) return false;
  for (const asset of assets) {
    const found = remote.find((item) => item.name === asset.name);
    if (!found || !await matches(github, found, asset)) return false;
  }
  return true;
}

export async function publishRelease({ bundlesDir, tag, sha, version, github }) {
  const identity = { tag, sha, version };
  // Complete local validation precedes even the first release mutation.
  const assets = await validateCompleteSet(bundlesDir, identity);
  async function current() {
    if (await github.resolveTag(tag) !== sha) throw new Error('Release tag moved away from the verified SHA.');
    const release = await github.getRelease(tag);
    if (!release || release.tag_name !== tag || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('A precreated release draft for the exact tag is required.');
    return release;
  }
  let release = await current();
  const releaseId = release.id;
  const prerelease = release.prerelease;
  if (!release.draft) {
    checkMarker(release, identity);
    if (!await exactRemote(github, release, assets)) throw immutableError();
    // Tag/state may have changed during streamed comparisons; a read-only rerun never repairs it.
    const final = await current();
    if (final.id !== releaseId || final.draft || final.prerelease !== prerelease) throw new Error('Release changed during verification.');
    checkMarker(final, identity);
    return { status: 'unchanged', assets: assets.length };
  }

  const marked = checkMarker(release, identity, false);
  const remote = await github.listAssets(release.id);
  if (!marked && remote.length) throw new Error('An unmarked draft must be empty; existing assets have no verified-SHA provenance.');
  // Compute the whole reconciliation before mutating. A read/download failure cannot cause deletion.
  const remove = [];
  const upload = [];
  for (const item of remote) {
    if (!assets.some((asset) => asset.name === item.name)) remove.push(item);
  }
  for (const asset of assets) {
    const existing = remote.filter((item) => item.name === asset.name);
    if (existing.length === 1 && await matches(github, existing[0], asset)) continue;
    remove.push(...existing);
    upload.push(asset);
  }

  async function draftGuard(requireMarker = true) {
    const next = await current();
    if (next.id !== releaseId || !next.draft || next.prerelease !== prerelease) throw new Error('Release is no longer the same draft; refusing mutation.');
    checkMarker(next, identity, requireMarker);
    return next;
  }
  if (!marked) {
    release = await draftGuard(false);
    // Recheck emptiness before claiming an initial draft; target_commitish is deliberately ignored.
    if ((await github.listAssets(release.id)).length) throw new Error('Draft changed before provenance was recorded.');
    const body = `${release.body ?? ''}${release.body ? '\n\n' : ''}${provenanceMarker(identity)}`;
    await github.editRelease(release.id, { body });
  }
  for (const asset of remove) {
    await draftGuard();
    await github.deleteAsset(asset.id);
  }
  for (const asset of upload) {
    // Detect local disk changes since validation before sending bytes.
    const digest = await hashFile(asset.file);
    if (digest.size !== asset.size || digest.sha256 !== asset.sha256) throw new Error(`Local release asset changed: ${asset.name}`);
    await draftGuard();
    await github.uploadAsset(releaseId, asset);
  }
  release = await draftGuard();
  if (!await exactRemote(github, release, assets)) throw new Error('Final draft asset validation failed; leaving the release draft.');
  // The last write is the sole public transition. Preserve title, notes and prerelease classification.
  await draftGuard();
  await github.editRelease(releaseId, { draft: false });
  release = await current();
  checkMarker(release, identity);
  if (release.id !== releaseId || release.draft || release.prerelease !== prerelease || !await exactRemote(github, release, assets)) throw new Error('Published release readback failed. Do not repair public assets with this workflow.');
  return { status: 'published', assets: assets.length };
}

/** Small REST boundary, injected fetch in tests. Never follow asset-supplied URLs with credentials. */
export function createGitHubClient({ repository, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required.');
  const base = `/repos/${repository}`;
  function id(value) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid GitHub object id.');
    return value;
  }
  async function request(endpoint, { method = 'GET', body, stream = false, upload = false, size } = {}) {
    const response = await fetchImpl(`https://${upload ? 'uploads' : 'api'}.github.com${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: stream ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': upload ? 'application/octet-stream' : 'application/json' }),
        ...(size === undefined ? {} : { 'Content-Length': String(size) })
      },
      ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
      ...(upload ? { duplex: 'half' } : {})
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status}`);
    if (stream) return response;
    return response.status === 204 ? undefined : response.json();
  }
  return {
    async resolveTag(tag) {
      let object = (await request(`${base}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
      for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
        if (!/^[0-9a-f]{40}$/.test(object.sha)) throw new Error('Invalid tag object SHA.');
        object = (await request(`${base}/git/tags/${object.sha}`)).object;
      }
      if (object.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) throw new Error('Tag does not resolve to a commit.');
      return object.sha;
    },
    /** The release for this exact tag, draft or published. `GET /releases/tags/{tag}` never
     *  returns drafts (HTTP 404), so a draft is found in the authenticated release list; more than
     *  one release naming the tag is refused rather than guessed. */
    async getRelease(tag) {
      const found = [];
      const untagged = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await request(`${base}/releases?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('Invalid GitHub release listing.');
        for (const release of batch) {
          if (release?.tag_name === tag) found.push(release);
          else if (release?.draft === true && release.name === tag && /^untagged-[a-f0-9]+$/i.test(release.tag_name)) untagged.push(release.tag_name);
        }
        if (batch.length < 100) break;
      }
      if (found.length > 1) throw new Error('More than one release names this tag; refusing to choose.');
      // A title can help diagnose a missing tag, but only tag_name identifies a release to update.
      if (found.length === 0 && untagged.length === 1) {
        throw new Error(`Attach the existing tag ${tag} to draft ${untagged[0]}, then re-run the failed publish job.`);
      }
      return found[0] ?? null;
    },
    async listAssets(releaseId) {
      const assets = [];
      for (let page = 1; ; page++) {
        const batch = await request(`${base}/releases/${id(releaseId)}/assets?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('Invalid GitHub asset listing.');
        assets.push(...batch);
        if (batch.length < 100) return assets;
      }
    },
    async hashAsset(assetId) {
      const response = await request(`${base}/releases/assets/${id(assetId)}`, { stream: true });
      if (!response.body) throw new Error('Missing GitHub asset stream.');
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of response.body) { size += chunk.length; hash.update(chunk); }
      return { size, sha256: hash.digest('hex') };
    },
    editRelease: (releaseId, body) => request(`${base}/releases/${id(releaseId)}`, { method: 'PATCH', body }),
    deleteAsset: (assetId) => request(`${base}/releases/assets/${id(assetId)}`, { method: 'DELETE' }),
    uploadAsset: (releaseId, asset) => request(`${base}/releases/${id(releaseId)}/assets?name=${encodeURIComponent(asset.name)}`, { method: 'POST', body: createReadStream(asset.file), upload: true, size: asset.size })
  };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No publication overrides are supported.');
  const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const result = await publishRelease({
    bundlesDir: path.resolve('release-bundles'), version,
    tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA,
    github: createGitHubClient({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN })
  });
  console.log(`Release ${result.status}: ${result.assets} verified assets.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
