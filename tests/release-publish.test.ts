import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expectedAssets, hashFile, platforms, stageBundle, validateCompleteSet, type ReleaseAsset, type ReleaseIdentity } from '../scripts/release-artifacts.mjs';
import { createGitHubClient, provenanceMarker, publishRelease } from '../scripts/publish-release.mjs';

const identity = { tag: 'v1.2.3', sha: 'a'.repeat(40), version: '1.2.3' };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
async function bundles(id: ReleaseIdentity = identity) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'release-publish-')));
  dirs.push(root);
  const bundlesDir = path.join(root, 'bundles');
  await fs.mkdir(bundlesDir);
  for (const platform of platforms) {
    const sourceDir = path.join(root, platform);
    await fs.mkdir(sourceDir);
    const names = expectedAssets(id.version, platform);
    for (const name of names.filter((name) => !name.endsWith('.yml'))) await fs.writeFile(path.join(sourceDir, name), `bytes:${name}`);
    const files = [];
    for (const name of names.filter((name) => /\.(exe|dmg|zip|AppImage)$/.test(name))) files.push({ url: name, ...await hashFile(path.join(sourceDir, name)) });
    const legacy = files.find((file) => platform !== 'macos' || file.url.endsWith('.zip'))!;
    const manifest = names.find((name) => name.endsWith('.yml'))!;
    await fs.writeFile(path.join(sourceDir, manifest), JSON.stringify({ version: id.version, files: files.map(({ url, size, sha512 }) => ({ url, size, sha512 })), path: legacy.url, sha512: legacy.sha512 }));
    await stageBundle({ sourceDir, bundleDir: path.join(bundlesDir, platform), platform, ...id });
  }
  return { bundlesDir, assets: await validateCompleteSet(bundlesDir, id) };
}

interface RemoteAsset { id: number; name: string; size: number; state: string; digest: string | null; bytes: Buffer }
interface Call { method: string; path: string; body?: any }
/** Fake GitHub REST, not a second implementation of reconciliation. The production client and
 * orchestrator execute every request, upload stream, pagination and final PATCH against this. */
class GitHub {
  release: any = { id: 10, tag_name: identity.tag, draft: true, prerelease: false, body: 'Human release notes', name: 'Human title', target_commitish: 'deliberately-not-the-verified-sha' };
  tag: any = { type: 'commit', sha: identity.sha };
  tagObjects = new Map<string, any>();
  assets: RemoteAsset[] = [];
  calls: Call[] = [];
  mutations: Call[] = [];
  nextId = 1;
  digests = true;
  failAfter = 0;
  streamFailure = false;
  otherReleases: any[] = [];
  after: ((call: Call) => void | Promise<void>) | undefined;
  client = createGitHubClient({ repository: 'example/disposable', token: 'test-token', fetchImpl: this.fetch.bind(this) as typeof fetch });

  async seed(assets: ReleaseAsset[]) {
    for (const asset of assets) this.add(asset.name, await fs.readFile(asset.file));
  }
  add(name: string, bytes: Buffer) {
    const asset = { id: this.nextId++, name, bytes, size: bytes.length, state: 'uploaded', digest: this.digests ? `sha256:${createHash('sha256').update(bytes).digest('hex')}` : null };
    this.assets.push(asset);
    return asset;
  }
  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const call: Call = { method, path: url.pathname + url.search };
    this.calls.push(call);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
    expect(['api.github.com', 'uploads.github.com']).toContain(url.hostname);
    const endpoint = url.pathname.replace('/repos/example/disposable', '');
    let result: any;
    let status = 200;
    if (method === 'GET' && endpoint.startsWith('/git/ref/tags/')) result = { object: this.tag };
    else if (method === 'GET' && endpoint.startsWith('/git/tags/')) result = { object: this.tagObjects.get(endpoint.split('/').at(-1)!) };
    // Like GitHub: the by-tag lookup never returns drafts; the authenticated list does.
    else if (method === 'GET' && endpoint.startsWith('/releases/tags/')) { result = this.release; if (!result || this.release.draft) status = 404; }
    else if (method === 'GET' && endpoint === '/releases') {
      const page = Number(url.searchParams.get('page'));
      result = [...this.otherReleases, ...(this.release ? [this.release] : [])].slice((page - 1) * 100, page * 100);
    }
    else if (method === 'GET' && endpoint === '/releases/10/assets') {
      const page = Number(url.searchParams.get('page'));
      result = this.assets.slice((page - 1) * 100, page * 100).map(({ bytes, ...asset }) => asset);
    } else if (method === 'GET' && /^\/releases\/assets\/\d+$/.test(endpoint)) {
      expect(new Headers(init?.headers).get('Accept')).toBe('application/octet-stream');
      if (this.streamFailure) throw new Error('interrupted download');
      const asset = this.assets.find((item) => item.id === Number(endpoint.split('/').at(-1)))!;
      const stream = new ReadableStream({ start(controller) { controller.enqueue(asset.bytes.subarray(0, 3)); controller.enqueue(asset.bytes.subarray(3)); controller.close(); } });
      await this.after?.(call);
      return new Response(stream);
    } else if (method === 'PATCH' && endpoint === '/releases/10') {
      call.body = JSON.parse(String(init?.body));
      Object.assign(this.release, call.body);
      result = this.release;
    } else if (method === 'DELETE' && /^\/releases\/assets\/\d+$/.test(endpoint)) {
      this.assets = this.assets.filter((item) => item.id !== Number(endpoint.split('/').at(-1)));
      status = 204;
    } else if (method === 'POST' && endpoint === '/releases/10/assets') {
      expect(url.hostname).toBe('uploads.github.com');
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as any) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(new Headers(init?.headers).get('Content-Length')).toBe(String(bytes.length));
      result = this.add(url.searchParams.get('name')!, bytes);
      call.body = { name: result.name };
    } else throw new Error(`Unexpected request: ${method} ${url}`);
    if (method !== 'GET') {
      this.mutations.push(call);
      if (this.failAfter === this.mutations.length) throw new Error('response lost after accepted mutation');
    }
    // Snapshot the response before hooks move remote state, like a response in flight.
    const response = status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(result), { status });
    await this.after?.(call);
    return response;
  }
}

async function setup(id = identity) {
  const fixture = await bundles(id);
  const github = new GitHub();
  github.release.tag_name = id.tag;
  const publish = () => publishRelease({ bundlesDir: fixture.bundlesDir, ...id, github: github.client });
  return { ...fixture, github, publish };
}
const writes = (github: GitHub) => github.mutations.map((call) => call.method === 'PATCH' ? call.body : `${call.method} ${call.body?.name ?? call.path}`);

describe('single draft-first release publisher', () => {
  it.each([false, true])('exposes exactly 14 assets only as the last mutation; preserves notes/title/prerelease=%s', async (prerelease) => {
    const { github, publish, assets } = await setup();
    github.release.prerelease = prerelease;
    github.after = (call) => {
      if (call.method === 'POST' && github.assets.length === 5) github.release.body += '\nHuman mid-upload addition';
      if (call.method === 'PATCH' && call.body.draft === false) {
        expect(github.assets).toHaveLength(14);
        expect(github.calls.filter((call) => call.method === 'GET' && call.path.includes('/assets?')).length).toBeGreaterThanOrEqual(3);
      } else if (call.method !== 'GET') expect(github.release.draft).toBe(true);
    };
    expect(await publish()).toEqual({ status: 'published', assets: 14 });
    expect(writes(github)).toEqual([
      { body: `Human release notes\n\n${provenanceMarker(identity)}` },
      ...assets.map((asset) => `POST ${asset.name}`), { draft: false }
    ]);
    expect(github.release).toMatchObject({ draft: false, prerelease, name: 'Human title', body: `Human release notes\n\n${provenanceMarker(identity)}\nHuman mid-upload addition` });
    expect(github.assets.map((asset) => asset.name)).toEqual(expectedAssets(identity.version));
  });

  it.each(Array.from({ length: 16 }, (_, index) => index + 1))('resumes an accepted mutation with lost response at boundary %i without duplicate uploads or notes', async (boundary) => {
    const { github, publish } = await setup();
    github.failAfter = boundary;
    await expect(publish()).rejects.toThrow(/response lost/);
    expect(github.mutations).toHaveLength(boundary);
    expect(github.release.draft).toBe(boundary !== 16);
    github.failAfter = 0;
    const resumed = await publish();
    expect(resumed).toEqual({ status: boundary === 16 ? 'unchanged' : 'published', assets: 14 });
    expect(github.assets).toHaveLength(14);
    expect(new Set(github.assets.map((asset) => asset.name)).size).toBe(14);
    expect(github.mutations).toHaveLength(16);
    expect(github.mutations.filter((call) => call.method === 'POST')).toHaveLength(14);
    expect(github.mutations.filter((call) => call.method === 'PATCH' && call.body.body)).toHaveLength(1);
    expect(github.mutations.filter((call) => call.body?.draft === false)).toHaveLength(1);
  });

  it('finds the precreated draft among other releases, though GitHub hides drafts from the by-tag lookup', async () => {
    const { github, publish } = await setup();
    github.otherReleases = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, tag_name: `v0.0.${i}`, draft: i % 2 === 0, prerelease: false }));
    expect(github.release.draft).toBe(true);
    expect(await publish()).toEqual({ status: 'published', assets: 14 });
    expect(github.calls.some((call) => call.path.startsWith('/repos/example/disposable/releases?per_page=100&page=2'))).toBe(true);
  });

  it('diagnoses a matching release title with an unassigned tag and leaves the draft untouched', async () => {
    const { github, publish } = await setup();
    const placeholder = 'untagged-0123456789abcdef';
    github.release.tag_name = placeholder;
    github.release.name = identity.tag;
    await expect(publish()).rejects.toThrow(`Attach the existing tag ${identity.tag} to draft ${placeholder}`);
    expect(github.release).toMatchObject({ draft: true, tag_name: placeholder, body: 'Human release notes' });
    expect(github.mutations).toEqual([]);
  });

  it('refuses to choose when two releases name the tag', async () => {
    const { github, publish } = await setup();
    github.otherReleases = [{ ...github.release, id: 11 }];
    await expect(publish()).rejects.toThrow(/More than one release names this tag/);
    expect(github.mutations).toEqual([]);
  });

  it('an identical public rerun is read-only, including streamed digest fallback', async () => {
    const { github, publish, assets } = await setup();
    github.release.draft = false;
    github.release.body += `\n\n${provenanceMarker(identity)}`;
    github.digests = false;
    await github.seed(assets);
    expect(await publish()).toEqual({ status: 'unchanged', assets: 14 });
    expect(github.mutations).toEqual([]);
    expect(github.calls.filter((call) => /^\/repos\/example\/disposable\/releases\/assets\/\d+$/.test(call.path))).toHaveLength(14);
  });

  it.each(['missing', 'changed', 'extra', 'duplicate', 'size', 'state', 'wrong-marker', 'no-marker'])('refuses %s public releases with exactly zero mutations', async (mode) => {
    const { github, publish, assets } = await setup();
    github.release.draft = false;
    github.release.body += `\n\n${provenanceMarker(identity)}`;
    await github.seed(assets);
    if (mode === 'missing') github.assets.pop();
    if (mode === 'changed') github.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    if (mode === 'extra') github.add('extra.exe', Buffer.from('extra'));
    if (mode === 'duplicate') github.assets[1].name = github.assets[0].name;
    if (mode === 'size') github.assets[0].size++;
    if (mode === 'state') github.assets[0].state = 'starter';
    if (mode === 'wrong-marker') github.release.body = provenanceMarker({ ...identity, sha: 'b'.repeat(40) });
    if (mode === 'no-marker') github.release.body = 'legacy public notes';
    await expect(publish()).rejects.toThrow(/immutable|provenance/);
    expect(github.mutations).toEqual([]);
  });

  it('stream-compares every missing digest before publishing a draft', async () => {
    const { github, publish } = await setup();
    github.digests = false;
    expect(await publish()).toEqual({ status: 'published', assets: 14 });
    expect(github.calls.filter((call) => /^\/repos\/example\/disposable\/releases\/assets\/\d+$/.test(call.path))).toHaveLength(28);
  });

  it('rejects a bad streamed hash on a public release without changing anything', async () => {
    const { github, publish, assets } = await setup();
    github.release.draft = false;
    github.release.body = provenanceMarker(identity);
    github.digests = false;
    await github.seed(assets);
    github.assets[0].bytes[0] ^= 1;
    await expect(publish()).rejects.toThrow(/immutable/);
    expect(github.mutations).toEqual([]);
  });

  it('reconciles only a marked draft: deletes stale/changed/duplicate assets before uploads, preserves exact ones', async () => {
    const { github, publish, assets } = await setup();
    github.release.body += `\n${provenanceMarker(identity)}`;
    await github.seed(assets);
    const changed = github.assets[0];
    changed.digest = `sha256:${'0'.repeat(64)}`;
    const duplicate = github.add(assets[1].name, Buffer.from('duplicate'));
    const stale = github.add('stale.yml', Buffer.from('stale'));
    const duplicateOriginal = github.assets[1];
    expect(await publish()).toEqual({ status: 'published', assets: 14 });
    expect(writes(github)).toEqual([
      `DELETE /repos/example/disposable/releases/assets/${stale.id}`,
      `DELETE /repos/example/disposable/releases/assets/${changed.id}`,
      `DELETE /repos/example/disposable/releases/assets/${duplicateOriginal.id}`,
      `DELETE /repos/example/disposable/releases/assets/${duplicate.id}`,
      `POST ${assets[0].name}`, `POST ${assets[1].name}`, { draft: false }
    ]);
    expect(github.assets).toHaveLength(14);
  });

  it('leaves an interrupted replacement draft resumable', async () => {
    const { github, publish, assets } = await setup();
    github.release.body = provenanceMarker(identity);
    await github.seed(assets);
    github.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    github.failAfter = 1; // accepted delete; upload never began
    await expect(publish()).rejects.toThrow(/response lost/);
    expect(github.assets).toHaveLength(13);
    expect(github.release.draft).toBe(true);
    github.failAfter = 0;
    expect(await publish()).toEqual({ status: 'published', assets: 14 });
    expect(github.mutations.map((call) => call.method)).toEqual(['DELETE', 'POST', 'PATCH']);
  });

  it('fails before any draft mutation when an existing remote asset cannot be compared', async () => {
    const { github, publish, assets } = await setup();
    github.release.body = provenanceMarker(identity);
    github.digests = false;
    await github.seed(assets);
    github.add('stale', Buffer.from('stale'));
    github.streamFailure = true;
    await expect(publish()).rejects.toThrow(/interrupted download/);
    expect(github.mutations).toEqual([]);
  });

  it.each(['missing', 'tag', 'marker', 'duplicate-marker', 'unmarked-assets'])('refuses %s draft identity without mutations or release creation', async (mode) => {
    const { github, publish, assets } = await setup();
    if (mode === 'missing') github.release = null;
    if (mode === 'tag') github.release.tag_name = 'v9.9.9';
    if (mode === 'marker') github.release.body = provenanceMarker({ ...identity, sha: 'b'.repeat(40) });
    if (mode === 'duplicate-marker') github.release.body = `${provenanceMarker(identity)}\n${provenanceMarker(identity)}`;
    if (mode === 'unmarked-assets') await github.seed(assets.slice(0, 1));
    await expect(publish()).rejects.toThrow();
    expect(github.mutations).toEqual([]);
  });

  it('refuses a tag moved before publication regardless of target_commitish', async () => {
    const { github, publish } = await setup();
    github.release.target_commitish = identity.sha;
    github.tag.sha = 'b'.repeat(40);
    await expect(publish()).rejects.toThrow(/tag moved/);
    expect(github.mutations).toEqual([]);
  });

  it('resolves annotated tags to commits, not release.target_commitish', async () => {
    const { github, publish } = await setup();
    github.tag = { type: 'tag', sha: 'c'.repeat(40) };
    github.tagObjects.set('c'.repeat(40), { type: 'tag', sha: 'd'.repeat(40) });
    github.tagObjects.set('d'.repeat(40), { type: 'commit', sha: identity.sha });
    expect(await publish()).toEqual({ status: 'published', assets: 14 });
  });

  it('does not stamp an old draft with a newly verified SHA on a later run', async () => {
    const { github, bundlesDir, publish } = await setup();
    github.failAfter = 1;
    await expect(publish()).rejects.toThrow(/response lost/);
    const newIdentity = { ...identity, sha: 'b'.repeat(40) };
    for (const platform of platforms) {
      const file = path.join(bundlesDir, platform, 'release-bundle.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.sha = newIdentity.sha;
      await fs.writeFile(file, JSON.stringify(manifest));
    }
    github.tag.sha = newIdentity.sha;
    github.failAfter = 0;
    await expect(publishRelease({ ...newIdentity, bundlesDir, github: github.client })).rejects.toThrow(/provenance/);
    expect(github.mutations).toHaveLength(1);
  });

  it.each(['after-marker', 'during-upload', 'before-publication'])('refuses a tag moved %s, never publishing an incomplete or stale set', async (when) => {
    const { github, publish } = await setup();
    github.after = (call) => {
      if ((when === 'after-marker' && call.method === 'PATCH') || (when === 'during-upload' && call.method === 'POST' && github.assets.length === 3) || (when === 'before-publication' && call.method === 'GET' && call.path.includes('/assets?') && github.assets.length === 14)) github.tag.sha = 'b'.repeat(40);
    };
    await expect(publish()).rejects.toThrow(/tag moved/);
    expect(github.release.draft).toBe(true);
    expect(github.mutations.filter((call) => call.body?.draft === false)).toEqual([]);
    expect(github.assets).toHaveLength(when === 'after-marker' ? 0 : when === 'during-upload' ? 3 : 14);
  });

  it('stops before any further mutation if another writer exposes the draft mid-upload', async () => {
    const { github, publish } = await setup();
    github.after = (call) => { if (call.method === 'POST') github.release.draft = false; };
    await expect(publish()).rejects.toThrow(/no longer the same draft/);
    expect(github.mutations).toHaveLength(2); // marker + one upload; never edits public release
  });

  it('keeps the release draft if final remote contents differ after accepted uploads', async () => {
    const { github, publish } = await setup();
    github.after = (call) => { if (call.method === 'POST' && github.assets.length === 14) github.assets[0].digest = `sha256:${'0'.repeat(64)}`; };
    await expect(publish()).rejects.toThrow(/Final draft asset validation failed/);
    expect(github.release.draft).toBe(true);
    expect(github.mutations).toHaveLength(15);
  });

  it('rejects changed local files after validation and leaves the draft hidden', async () => {
    const { github, publish, assets } = await setup();
    github.after = async (call) => { if (call.method === 'PATCH') await fs.appendFile(assets[0].file, 'changed'); };
    await expect(publish()).rejects.toThrow(/Local release asset changed/);
    expect(github.mutations).toHaveLength(1);
    expect(github.release.draft).toBe(true);
  });

  it('validates the full local set before contacting GitHub at all', async () => {
    const { github, publish, bundlesDir } = await setup();
    await fs.rm(path.join(bundlesDir, 'linux'), { recursive: true });
    await expect(publish()).rejects.toThrow(/expected exactly/);
    expect(github.calls).toEqual([]);
  });

  it('paginates remote asset listings rather than overlooking stale assets after the first page', async () => {
    const { github, publish, assets } = await setup();
    github.release.draft = false;
    github.release.body = provenanceMarker(identity);
    await github.seed(assets);
    for (let index = 0; index < 100; index++) github.add(`extra-${index}`, Buffer.from('stale'));
    await expect(publish()).rejects.toThrow(/immutable/);
    expect(github.calls.some((call) => call.path.endsWith('page=2'))).toBe(true);
    expect(github.mutations).toEqual([]);
  });

  it('preserves prerelease classification for prerelease versions', async () => {
    const id = { ...identity, tag: 'v1.2.3-beta.1', version: '1.2.3-beta.1' };
    const { github, publish } = await setup(id);
    github.release.prerelease = true;
    expect(await publish()).toEqual({ status: 'published', assets: 14 });
    expect(github.release.prerelease).toBe(true);
    expect(github.mutations.at(-1)?.body).toEqual({ draft: false });
  });
});
