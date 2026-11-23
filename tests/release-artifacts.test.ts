import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectedAssets, hashFile, platforms, stageBundle, validateBundle, validateCompleteSet, validateIdentity, type ReleasePlatform } from '../scripts/release-artifacts.mjs';

const identity = { tag: 'v1.2.3', sha: 'a'.repeat(40), version: '1.2.3' };
const dirs: string[] = [];
async function temp() { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'release-artifacts-'))); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const manifestName = (platform: ReleasePlatform) => ({ windows: 'latest.yml', macos: 'latest-mac.yml', linux: 'latest-linux.yml' })[platform];

async function source(root: string, platform: ReleasePlatform, id = identity) {
  const dir = path.join(root, `source-${platform}`);
  await fs.mkdir(dir);
  const names = expectedAssets(id.version, platform);
  for (const name of names.filter((name) => !name.endsWith('.yml'))) await fs.writeFile(path.join(dir, name), `bytes for ${name}`);
  const files = [];
  for (const name of names.filter((name) => /\.(exe|dmg|zip|AppImage)$/.test(name))) files.push({ url: name, ...await hashFile(path.join(dir, name)) });
  const legacy = files.find((file) => platform !== 'macos' || file.url.endsWith('.zip'))!;
  await fs.writeFile(path.join(dir, manifestName(platform)), JSON.stringify({ version: id.version, files: files.map(({ url, size, sha512 }) => ({ url, size, sha512 })), path: legacy.url, sha512: legacy.sha512 }));
  return dir;
}
async function fixture(platform: ReleasePlatform = 'windows') {
  const root = await temp();
  const sourceDir = await source(root, platform);
  const bundleDir = path.join(root, 'bundle');
  await stageBundle({ sourceDir, bundleDir, platform, ...identity });
  return { root, sourceDir, bundleDir, platform };
}
async function mutateJson(file: string, mutate: (value: any) => void) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  mutate(value);
  await fs.writeFile(file, JSON.stringify(value));
}
async function reseal(dir: string, name: string) {
  const digest = await hashFile(path.join(dir, name));
  await mutateJson(path.join(dir, 'release-bundle.json'), (manifest) => Object.assign(manifest.assets.find((asset: any) => asset.name === name), digest));
}

describe('complete release bundles', () => {
  it.each(['event', 'workflow', 'missing'])('refuses to attest a different or unproven %s source commit', (mismatch) => {
    const root = path.resolve(import.meta.dirname, '..');
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-artifacts.mjs'), 'identity'], {
      cwd: root,
      env: { ...process.env, GITHUB_ACTIONS: 'true', RELEASE_TAG: `v${version}`, RELEASE_SHA: identity.sha,
        GITHUB_SHA: mismatch === 'event' ? 'b'.repeat(40) : identity.sha,
        RELEASE_WORKFLOW_SHA: mismatch === 'workflow' ? 'b'.repeat(40) : mismatch === 'missing' ? '' : identity.sha },
      encoding: 'utf8'
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dispatch the release workflow from the release tag');
  });

  it('stages only 14 known files across three bundles and excludes build output', async () => {
    const root = await temp();
    const bundles = path.join(root, 'bundles');
    await fs.mkdir(bundles);
    for (const platform of platforms) {
      const sourceDir = await source(root, platform);
      await fs.writeFile(path.join(sourceDir, 'builder-debug.yml'), 'not for publication');
      await fs.mkdir(path.join(sourceDir, 'unpacked'));
      await stageBundle({ sourceDir, bundleDir: path.join(bundles, platform), platform, ...identity });
    }
    const assets = await validateCompleteSet(bundles, identity);
    expect(assets.map((asset) => asset.name)).toEqual(expectedAssets(identity.version));
    expect(assets).toHaveLength(14);
    expect(expectedAssets(identity.version, 'windows')).toHaveLength(3);
    expect(expectedAssets(identity.version, 'macos')).toHaveLength(9);
    expect(expectedAssets(identity.version, 'linux')).toHaveLength(2);
    expect(assets.every((asset) => asset.size > 0 && /^[0-9a-f]{64}$/.test(asset.sha256))).toBe(true);
  });

  it.each([
    { ...identity, tag: 'v9.9.9' }, { ...identity, tag: '../v1.2.3' },
    { ...identity, version: '01.2.3', tag: 'v01.2.3' }, { ...identity, sha: 'master' },
    { ...identity, version: '1.2.3\n', tag: 'v1.2.3\n' }, { ...identity, sha: `${identity.sha}\n` }
  ])('rejects invalid package/tag/SHA identity before staging: %j', (id) => {
    expect(() => validateIdentity(id)).toThrow();
  });

  it('supports prerelease package/tag identity without changing channel filenames', async () => {
    const id = { ...identity, version: '1.2.3-beta.4', tag: 'v1.2.3-beta.4' };
    const root = await temp();
    const sourceDir = await source(root, 'windows', id);
    const assets = await stageBundle({ sourceDir, bundleDir: path.join(root, 'bundle'), platform: 'windows', ...id });
    expect(assets.map((asset) => asset.name)).toContain('latest.yml');
  });

  it.each(['tag', 'sha', 'version', 'platform', 'schema'])('rejects mismatched %s provenance', async (field) => {
    const { bundleDir, platform } = await fixture();
    await mutateJson(path.join(bundleDir, 'release-bundle.json'), (manifest) => { manifest[field] = 'wrong'; });
    await expect(validateBundle(bundleDir, identity, platform)).rejects.toThrow(/provenance/);
  });

  it.each(['missing', 'extra', 'duplicate', 'traversal', 'corrupt', 'size', 'digest'])('rejects %s bundle assets', async (mode) => {
    const { bundleDir, platform } = await fixture();
    const name = expectedAssets(identity.version, platform)[0];
    if (mode === 'missing') await fs.rm(path.join(bundleDir, name));
    if (mode === 'extra') await fs.writeFile(path.join(bundleDir, 'stray.exe'), 'extra');
    if (mode === 'corrupt') await fs.appendFile(path.join(bundleDir, name), 'corrupt');
    if (['duplicate', 'traversal', 'size', 'digest'].includes(mode)) await mutateJson(path.join(bundleDir, 'release-bundle.json'), (manifest) => {
      if (mode === 'duplicate') manifest.assets.push(manifest.assets[0]);
      if (mode === 'traversal') manifest.assets[0].name = '../outside.exe';
      if (mode === 'size') manifest.assets[0].size++;
      if (mode === 'digest') manifest.assets[0].sha256 = '0'.repeat(64);
    });
    await expect(validateBundle(bundleDir, identity, platform)).rejects.toThrow();
  });

  it.each(['version', 'url', 'duplicate', 'missing', 'hash', 'size', 'legacy-path', 'legacy-hash', 'legacy-sha2', 'packages', 'block-size'])('rejects updater %s even with a resealed bundle digest', async (mode) => {
    const { bundleDir, platform } = await fixture();
    const name = manifestName(platform);
    await mutateJson(path.join(bundleDir, name), (info) => {
      if (mode === 'version') info.version = '9.9.9';
      if (mode === 'url') info.files[0].url = 'https://evil.example/installer.exe';
      if (mode === 'duplicate') info.files.push(info.files[0]);
      if (mode === 'missing') info.files = [];
      if (mode === 'hash') info.files[0].sha512 = 'wrong';
      if (mode === 'size') info.files[0].size++;
      if (mode === 'legacy-path') info.path = '../outside.exe';
      if (mode === 'legacy-hash') info.sha512 = 'wrong';
      if (mode === 'legacy-sha2') info.sha2 = 'wrong';
      if (mode === 'packages') info.packages = { x64: { path: 'outside.exe' } };
      if (mode === 'block-size') info.files[0].blockMapSize = info.files[0].size + 1;
    });
    await reseal(bundleDir, name);
    await expect(validateBundle(bundleDir, identity, platform)).rejects.toThrow(/updater|Updater|Invalid|references/);
  });

  it('requires both mac architectures in the merged feed and a zip legacy reference', async () => {
    const { bundleDir, platform } = await fixture('macos');
    await mutateJson(path.join(bundleDir, 'latest-mac.yml'), (info) => {
      const dmg = info.files.find((file: any) => file.url.endsWith('.dmg'));
      info.path = dmg.url;
      info.sha512 = dmg.sha512;
    });
    await reseal(bundleDir, 'latest-mac.yml');
    await expect(validateBundle(bundleDir, identity, platform)).rejects.toThrow(/legacy/);
  });

  it('rejects duplicate YAML keys rather than taking the last reference', async () => {
    const { sourceDir, root } = await fixture();
    await fs.writeFile(path.join(sourceDir, 'latest.yml'), 'version: 1.2.3\nversion: 9.9.9\n');
    await expect(stageBundle({ sourceDir, bundleDir: path.join(root, 'bad'), platform: 'windows', ...identity })).rejects.toThrow(/duplicated/);
  });

  it('rejects directory junctions in sources and bundles without traversing their files', async () => {
    const { root, sourceDir } = await fixture();
    const linked = path.join(root, 'linked');
    await fs.symlink(sourceDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(stageBundle({ sourceDir: linked, bundleDir: path.join(root, 'bad'), platform: 'windows', ...identity })).rejects.toThrow(/real release directory/);
    await expect(validateBundle(linked, identity, 'windows')).rejects.toThrow(/real release directory/);
  });

  it('rejects links/directories in an allowlisted file slot and refuses an existing destination', async () => {
    const { sourceDir, bundleDir, root } = await fixture();
    await expect(stageBundle({ sourceDir, bundleDir, platform: 'windows', ...identity })).rejects.toThrow();
    const name = expectedAssets(identity.version, 'windows')[0];
    await fs.rm(path.join(sourceDir, name));
    await fs.symlink(root, path.join(sourceDir, name), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(stageBundle({ sourceDir, bundleDir: path.join(root, 'bad'), platform: 'windows', ...identity })).rejects.toThrow(/regular/);
  });

  if (process.platform !== 'win32') it('rejects file symlinks on POSIX (Windows uses the junction coverage above)', async () => {
    const { sourceDir, root } = await fixture();
    const name = expectedAssets(identity.version, 'windows')[0];
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, 'outside');
    await fs.rm(path.join(sourceDir, name));
    await fs.symlink(outside, path.join(sourceDir, name));
    await expect(stageBundle({ sourceDir, bundleDir: path.join(root, 'bad'), platform: 'windows', ...identity })).rejects.toThrow(/regular/);
  });

  it('rejects a missing platform bundle rather than publishing a partial set', async () => {
    const root = await temp();
    await fs.mkdir(path.join(root, 'windows'));
    await expect(validateCompleteSet(root, identity)).rejects.toThrow(/expected exactly/);
  });
});

/** Real locked-builder orchestration: --publish never must still create valid, merged updater YAML. */
describe('locked electron-builder metadata contract', () => {
  const require = createRequire(import.meta.url);
  const { PublishManager } = require('app-builder-lib/out/publish/PublishManager');
  const { Platform } = require('app-builder-lib/out/core');
  const { Arch, getArtifactArchName } = require('builder-util');
  const { CancellationToken } = require('builder-util-runtime');
  const { expandMacro } = require('app-builder-lib/out/util/macroExpander');
  const yaml = createRequire(require.resolve('app-builder-lib/package.json'))('js-yaml');

  it.each(platforms)('produces %s metadata with no publisher/token and feeds the staging validator', async (platform) => {
    const root = await temp();
    const dir = path.join(root, 'dist');
    await fs.mkdir(dir);
    const config = yaml.load(await fs.readFile(path.resolve('electron-builder.yml'), 'utf8'));
    const emitted: any[] = [];
    let afterPack!: (event: any) => Promise<void>;
    let artifactCreated!: (event: any) => Promise<void>;
    const appInfo = { version: identity.version, channel: null, updaterCacheDirName: 'vocs-code-updater' };
    const rootPackager: any = {
      config, appInfo, metadata: { dependencies: { 'electron-updater': '^6.8.9' } },
      cancellationToken: new CancellationToken(),
      repositoryInfo: Promise.resolve({ type: 'github', user: 'vocsong', project: 'VocsCode' }),
      onAfterPack: (cb: typeof afterPack) => { afterPack = cb; },
      onArtifactCreated: (cb: typeof artifactCreated) => { artifactCreated = cb; },
      emitArtifactCreated: async (event: any) => { emitted.push(event); await artifactCreated(event); }
    };
    const buildKey = { windows: 'win', macos: 'mac', linux: 'linux' }[platform];
    const packager: any = {
      info: rootPackager, config, appInfo, platformSpecificBuildOptions: config[buildKey],
      platform: { windows: Platform.WINDOWS, macos: Platform.MAC, linux: Platform.LINUX }[platform],
      expandMacro: (pattern: string, arch: string) => expandMacro(pattern, arch, appInfo),
      getResource: async () => null,
      getResourcesDir: () => dir
    };
    const manager = new PublishManager(rootPackager, { publish: 'never' });
    const upload = vi.spyOn(manager, 'scheduleUpload').mockRejectedValue(new Error('must never publish'));
    await afterPack({ packager, electronPlatformName: platform === 'macos' ? 'darwin' : platform === 'windows' ? 'win32' : 'linux', targets: [{ name: platform === 'windows' ? 'nsis' : platform === 'macos' ? 'zip' : 'appimage' }], arch: Arch.x64, appOutDir: dir });
    const updateConfig = yaml.load(await fs.readFile(path.join(dir, 'app-update.yml'), 'utf8'));
    expect(updateConfig).toMatchObject({ provider: 'github', releaseType: 'draft', owner: 'vocsong', repo: 'VocsCode' });
    expect(getArtifactArchName(Arch.x64, 'AppImage')).toBe('x86_64');
    for (const name of expectedAssets(identity.version, platform).filter((name) => !name.endsWith('.yml'))) {
      const file = path.join(dir, name);
      await fs.writeFile(file, `builder ${name}`);
      if (name.endsWith('.blockmap')) continue;
      await artifactCreated({ file, packager, arch: name.includes('arm64') ? Arch.arm64 : Arch.x64, isWriteUpdateInfo: true,
        target: { name: name.endsWith('.exe') ? 'nsis' : path.extname(name).slice(1), options: {}, outDir: dir },
        updateInfo: { size: (await fs.stat(file)).size, sha512: createHash('sha512').update(await fs.readFile(file)).digest('base64') } });
    }
    await manager.awaitTasks();
    expect(upload).not.toHaveBeenCalled();
    expect(manager.isPublish).toBe(false);
    expect(emitted.map((event) => path.basename(event.file))).toEqual([manifestName(platform)]);
    const assets = await stageBundle({ sourceDir: dir, bundleDir: path.join(root, 'bundle'), platform, ...identity });
    expect(assets).toHaveLength(expectedAssets(identity.version, platform).length);
    if (platform === 'macos') {
      const feed = yaml.load(await fs.readFile(path.join(dir, 'latest-mac.yml'), 'utf8'));
      expect(feed.files).toHaveLength(4);
      expect(feed.path).toBe('Vocs-Code-1.2.3-mac-x64.zip');
    }
  });
});
