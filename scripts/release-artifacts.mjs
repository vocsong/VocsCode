/** Allowlisted release bundles. No globbed build output or artifact-supplied paths reach GitHub. */
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Use the YAML parser already locked with the dev-only builder, not a new runtime dependency.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const yaml = builderRequire('js-yaml');
export const platforms = ['windows', 'macos', 'linux'];
const bundleManifest = 'release-bundle.json';

export function validateIdentity({ tag, sha, version }) {
  if (typeof version !== 'string' || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) || tag !== `v${version}`) {
    throw new Error('Release tag must equal v + package.json version (vX.Y.Z with optional prerelease).');
  }
  if (typeof sha !== 'string' || sha.length !== 40 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid verified commit SHA.');
}

export function expectedAssets(version, platform) {
  validateIdentity({ tag: `v${version}`, sha: '0'.repeat(40), version });
  const prefix = `Vocs-Code-${version}`;
  const byPlatform = {
    windows: [`${prefix}-win-x64.exe`, `${prefix}-win-x64.exe.blockmap`, 'latest.yml'],
    macos: ['x64', 'arm64'].flatMap((arch) => ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap'].map((ext) => `${prefix}-mac-${arch}.${ext}`)).concat('latest-mac.yml'),
    linux: [`${prefix}-linux-x86_64.AppImage`, 'latest-linux.yml']
  };
  if (platform === undefined) return platforms.flatMap((key) => byPlatform[key]);
  if (!platforms.includes(platform)) throw new Error(`Unknown release platform: ${platform}`);
  return byPlatform[platform];
}

async function directory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(dir)) !== path.resolve(dir)) throw new Error(`Not a real release directory: ${dir}`);
}

async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Not a nonempty regular release file: ${file}`);
  return stat;
}

export async function hashFile(file) {
  await regularFile(file);
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

async function readSmall(file) {
  if ((await regularFile(file)).size > 64 * 1024) throw new Error(`Release metadata too large: ${file}`);
  return fs.readFile(file, 'utf8');
}

function exactNames(actual, expected, context) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || [...actual].sort().some((name, i) => name !== [...expected].sort()[i])) {
    throw new Error(`${context}: expected exactly ${expected.join(', ')}; got ${actual.join(', ')}`);
  }
}

function keys(value, allowed, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${context} fields.`);
}

/** Validate the actual updater-facing references, including the old path/sha512 compatibility pair. */
async function validateUpdater(dir, platform, version, assets) {
  const manifest = { windows: 'latest.yml', macos: 'latest-mac.yml', linux: 'latest-linux.yml' }[platform];
  const info = yaml.load(await readSmall(path.join(dir, manifest)), { schema: yaml.JSON_SCHEMA });
  keys(info, ['version', 'files', 'path', 'sha512', 'sha2', 'releaseDate', 'releaseName', 'releaseNotes'], manifest);
  if (info.version !== version || !Array.isArray(info.files)) throw new Error(`Invalid updater version/files in ${manifest}.`);
  const binaries = assets.filter((asset) => /\.(exe|dmg|zip|AppImage)$/.test(asset.name));
  exactNames(info.files.map((file) => file?.url), binaries.map((asset) => asset.name), `${manifest} references`);
  for (const entry of info.files) {
    keys(entry, ['url', 'sha512', 'size', 'blockMapSize', 'isAdminRightsRequired'], `${manifest} file`);
    const asset = binaries.find((item) => item.name === entry.url);
    if (entry.sha512 !== asset.sha512 || entry.size !== asset.size) throw new Error(`Updater hash/size mismatch: ${entry.url}`);
    if (entry.blockMapSize !== undefined && (!Number.isSafeInteger(entry.blockMapSize) || entry.blockMapSize <= 0 || entry.blockMapSize > entry.size)) throw new Error(`Invalid blockMapSize: ${entry.url}`);
    if (entry.isAdminRightsRequired !== undefined && typeof entry.isAdminRightsRequired !== 'boolean') throw new Error(`Invalid admin flag: ${entry.url}`);
  }
  const legacy = binaries.find((item) => item.name === info.path);
  if (!legacy || info.sha512 !== legacy.sha512 || (platform === 'macos' && !legacy.name.endsWith('.zip')) || (info.sha2 !== undefined && info.sha2 !== legacy.sha256)) {
    throw new Error(`Invalid legacy updater reference in ${manifest}.`);
  }
}

export async function validateBundle(dir, identity, platform) {
  validateIdentity(identity);
  const names = expectedAssets(identity.version, platform);
  await directory(dir);
  exactNames(await fs.readdir(dir), [...names, bundleManifest], `${platform} bundle`);
  const manifest = JSON.parse(await readSmall(path.join(dir, bundleManifest)));
  keys(manifest, ['schema', 'tag', 'sha', 'version', 'platform', 'assets'], 'bundle manifest');
  if (manifest.schema !== 1 || manifest.tag !== identity.tag || manifest.sha !== identity.sha || manifest.version !== identity.version || manifest.platform !== platform || !Array.isArray(manifest.assets)) throw new Error(`Bundle provenance mismatch: ${platform}`);
  exactNames(manifest.assets.map((asset) => asset?.name), names, `${platform} manifest`);
  const assets = [];
  // Paths are constructed from our allowlist, never from the untrusted manifest.
  for (const name of names) {
    const declared = manifest.assets.find((asset) => asset.name === name);
    keys(declared, ['name', 'size', 'sha256', 'sha512'], 'bundle asset');
    const file = path.join(dir, name);
    const digest = await hashFile(file);
    if (digest.size !== declared.size || digest.sha256 !== declared.sha256 || digest.sha512 !== declared.sha512) throw new Error(`Bundle digest mismatch: ${name}`);
    assets.push({ name, file, ...digest });
  }
  await validateUpdater(dir, platform, identity.version, assets);
  return assets;
}

export async function validateCompleteSet(dir, identity) {
  validateIdentity(identity);
  await directory(dir);
  exactNames(await fs.readdir(dir), platforms, 'Release bundles');
  const assets = [];
  for (const platform of platforms) assets.push(...await validateBundle(path.join(dir, platform), identity, platform));
  exactNames(assets.map((asset) => asset.name), expectedAssets(identity.version), 'Complete release');
  return assets;
}

export async function stageBundle({ sourceDir, bundleDir, platform, ...identity }) {
  validateIdentity(identity);
  const names = expectedAssets(identity.version, platform);
  await directory(sourceDir);
  const assets = [];
  for (const name of names) assets.push({ name, ...await hashFile(path.join(sourceDir, name)) });
  await validateUpdater(sourceDir, platform, identity.version, assets);
  // Never merge into an old bundle (or follow a destination symlink).
  await fs.mkdir(bundleDir);
  for (const name of names) await fs.copyFile(path.join(sourceDir, name), path.join(bundleDir, name), constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(bundleDir, bundleManifest), `${JSON.stringify({ schema: 1, ...identity, platform, assets }, null, 2)}\n`, { flag: 'wx' });
  return validateBundle(bundleDir, identity, platform);
}

async function main() {
  const [command, platform] = process.argv.slice(2);
  const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
  const identity = { tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA, version };
  validateIdentity(identity);
  // GitHub's standard provenance records the invocation source, not an arbitrary checkout.
  // Dispatch from the tag so the signed source, workflow and actual build all name this commit.
  if (process.env.GITHUB_ACTIONS === 'true' &&
      (process.env.GITHUB_SHA !== identity.sha || process.env.RELEASE_WORKFLOW_SHA !== identity.sha)) {
    throw new Error('Dispatch the release workflow from the release tag: event, workflow and verified build SHA must match for provenance.');
  }
  if (command === 'identity' && platform === undefined) return;
  if (command !== 'stage' || process.argv.length !== 4) throw new Error('Usage: release-artifacts.mjs identity | stage <windows|macos|linux>');
  await stageBundle({ sourceDir: path.resolve('dist'), bundleDir: path.resolve('release-bundle'), platform, ...identity });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
