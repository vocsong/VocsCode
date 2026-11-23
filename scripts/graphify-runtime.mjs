import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Use the locked builder's archive readers, not system tar/unzip or target Python.
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const { Arch } = builderRequire('builder-util');
const tar = builderRequire('tar');
const unzip = builderRequire('unzipper');
const root = path.resolve(import.meta.dirname, '..');
const sources = path.join(root, 'resources/graphify');
const cache = path.resolve(process.env.VOCS_GRAPHIFY_BUILD_CACHE || path.join(root, '.graphify-build-cache'));
export const devRoot = path.join(root, 'resources/graphify-runtime');
export const host = `${process.platform}-${process.arch}`;
export const triples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestName = 'runtime.json';
const rm = (file) => fs.rm(file, { recursive: true, force: true, maxRetries: 3 });
const MiB = 1024 ** 2;

function validWheelTag(tag, target) {
  if (target === 'win32-x64') return tag === 'win_amd64';
  if (target === 'linux-x64') {
    const version = /^manylinux_2_(\d+)_x86_64$/.exec(tag);
    return /^manylinux(1|2010|2014)_x86_64$/.test(tag) || (version && Number(version[1]) <= 17);
  }
  const platform = /^macosx_(\d+)_(\d+)_(x86_64|arm64|universal2)$/.exec(tag);
  const arch = target === 'darwin-x64' ? 'x86_64' : 'arm64';
  return platform && (Number(platform[1]) < 12 || (platform[1] === '12' && platform[2] === '0')) &&
    (platform[3] === arch || platform[3] === 'universal2');
}

function artifactFile(artifact) {
  if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isInteger(artifact.size) ||
      artifact.size < 1 || artifact.size > 100 * MiB) throw new Error('Artifact needs a valid SHA-256 and size');
  return decodeURIComponent(new URL(artifact.url).pathname.split('/').pop());
}

export function readPlan(lock, target) {
  if (!Object.hasOwn(triples, target)) throw new Error(`No locked runtime for ${target}; supported: ${Object.keys(triples).join(', ')}`);
  const { version: python, release } = lock.python;
  const distro = lock.python.artifacts[target];
  const archive = artifactFile(distro);
  if (distro.url !== `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${archive.replace('+', '%2B')}` ||
      !/^3\.12\.\d+$/.test(python) || !/^\d{8}$/.test(release) ||
      archive !== `cpython-${python}+${release}-${triples[target]}-install_only_stripped.tar.gz`) {
    throw new Error(`Unexpected Python standalone archive for ${target}`);
  }
  const packages = new Map();
  for (const { name, version, artifacts } of lock.wheels) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !/^\d+(?:\.\d+)+$/.test(version) || packages.has(name)) {
      throw new Error(`Invalid or duplicate wheel pin: ${name}==${version}`);
    }
    const artifact = artifacts.any ?? artifacts[target];
    const wheel = artifactFile(artifact);
    const stem = `${name.replaceAll('-', '_')}-${version}`;
    if (!/^https:\/\/files\.pythonhosted\.org\/packages\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{60}\/[a-zA-Z0-9_.-]+\.whl$/.test(artifact.url) ||
        !wheel.startsWith(`${stem}-`) || !wheel.endsWith('.whl')) throw new Error(`Unexpected wheel: ${wheel}`);
    const [abi, linkage, tags] = wheel.slice(stem.length + 1, -4).split('-');
    const common = abi === 'py3' && linkage === 'none' && tags === 'any';
    const native = (abi === 'cp312' && linkage === 'cp312') || (/^cp3(?:8|9|10|11|12)$/.test(abi) && linkage === 'abi3');
    if (artifacts.any ? !common : !native || !tags?.split('.').some((tag) => validWheelTag(tag, target))) {
      throw new Error(`Wheel ${wheel} is incompatible with CPython 3.12 on ${target}`);
    }
    const notice = name === 'tree-sitter-groovy' && version === '0.1.2' ? 'tree-sitter-groovy-0.1.2-MIT.txt' : undefined;
    packages.set(name, { name, version, stem, artifact, notice });
  }
  if (packages.get('graphifyy')?.version !== '0.9.115') throw new Error('Expected graphifyy==0.9.115');
  return { distro, python, packages, target };
}

export async function loadPlan(target) {
  const bytes = await fs.readFile(path.join(sources, 'artifacts.lock.json'));
  return { ...readPlan(JSON.parse(bytes), target), lockSha256: sha256(bytes) };
}

export function verifyArtifact(artifact, bytes) {
  if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) {
    throw new Error(`Size or SHA-256 mismatch for ${artifactFile(artifact)}`);
  }
  return bytes;
}

async function download(artifact) {
  let url = new URL(artifact.url);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !['files.pythonhosted.org', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
      throw new Error(`Unapproved artifact endpoint: ${url.origin}`);
    }
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
      url = new URL(response.headers.get('location'), url);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Artifact download failed (HTTP ${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > artifact.size) throw new Error(`Download larger than pinned size for ${artifactFile(artifact)}`);
      chunks.push(chunk);
    }
    return verifyArtifact(artifact, Buffer.concat(chunks, size));
  }
  throw new Error('Too many artifact redirects');
}

export async function getArtifact(artifact, cacheDir = cache, fetchArtifact = download) {
  const file = path.join(cacheDir, artifact.sha256);
  const stat = await fs.lstat(file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  if (stat) {
    if (!stat.isFile() || stat.size !== artifact.size) throw new Error(`Invalid Graphify cache entry; remove ${file}`);
    try {
      return verifyArtifact(artifact, await fs.readFile(file));
    } catch (e) {
      throw new Error(`Unverified Graphify cache entry; remove ${file}: ${e.message}`);
    }
  }
  const bytes = verifyArtifact(artifact, await fetchArtifact(artifact));
  await fs.mkdir(cacheDir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await rm(temporary);
  }
  return bytes;
}

export function pythonExe(directory, target) {
  return path.join(directory, target === 'win32-x64' ? 'python/python.exe' : 'python/bin/python3');
}

function safeParts(name) {
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\x00]/.test(part))) {
    throw new Error(`Unsafe path in Graphify archive: ${name}`);
  }
  return parts;
}

async function unpackPython(plan, directory) {
  const win = plan.target === 'win32-x64';
  const stdlib = win ? 'python/Lib' : 'python/lib/python3.12';
  const excluded = [
    'python/include', 'python/libs', 'python/Scripts', 'python/pythonw.exe', 'python/share/man',
    'python/lib/pkgconfig', 'python/lib/libpython3.12.so', // unused linker alias; retain .so.1.0
    `${stdlib}/ensurepip`, `${stdlib}/site-packages`, `${stdlib}/test`, `${stdlib}/idlelib`,
    `${stdlib}/tkinter`, `${stdlib}/turtledemo`,
  ];
  const bytes = await getArtifact(plan.distro);
  await pipeline(Readable.from([bytes]), tar.x({
    cwd: directory, strict: true, noMtime: true,
    filter(name, entry) {
      if (safeParts(name)[0] !== 'python') throw new Error(`Unexpected Python archive entry: ${name}`);
      if (excluded.some((prefix) => name === prefix || name.startsWith(`${prefix}/`)) ||
          (name.startsWith('python/bin/') && name !== 'python/bin/' && name !== 'python/bin/python3.12') ||
          name.startsWith(`${stdlib}/config-`) || name.endsWith('.pyc') || name.includes('/__pycache__/')) return false;
      // Retain no interpreter links that a cross-target build host may be unable to create.
      if (name.startsWith('python/share/terminfo/') && entry.type === 'SymbolicLink') return false;
      if (!['Directory', 'File'].includes(entry.type)) throw new Error(`Unexpected Python archive entry type: ${name} (${entry.type})`);
      return true;
    },
  }));
  if (!win) {
    await fs.rename(path.join(directory, 'python/bin/python3.12'), pythonExe(directory, plan.target));
    await fs.chmod(pythonExe(directory, plan.target), 0o755);
  }
}

async function unpackWheel(vendor, pkg) {
  const bytes = await getArtifact(pkg.artifact);
  const { files } = await unzip.Open.buffer(bytes);
  let metadata = false;
  let license = false;
  // No PEP 517/build hooks, .pth evaluation or script entry-point generation.
  // Only wheels with importable files at their root are pinned. Keep .data/data
  // as inert data alongside dist-info, not as an additional search path.
  for (const entry of files) {
    const parts = safeParts(entry.path);
    if (entry.type === 'Directory') continue;
    if ((entry.externalFileAttributes >>> 28) === 0xa || entry.type !== 'File' ||
        (parts[0].endsWith('.data') && !(parts[0] === `${pkg.stem}.data` && parts[1] === 'data')) ||
        entry.path.endsWith('.pth')) throw new Error(`Unsupported entry in ${pkg.name}: ${entry.path}`);
    const dest = path.join(vendor, ...parts);
    if (parts[0] === `${pkg.stem}.dist-info`) {
      if (parts[1] === 'METADATA') metadata = true;
      if (parts[1] === 'licenses' || /^(license|copying|notice)/i.test(parts[1])) license = true;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(dest, { flags: 'wx' }));
  }
  if (!metadata || (!license && !pkg.notice)) throw new Error(`Missing wheel metadata or license: ${pkg.name}`);
}

async function* filesIn(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* filesIn(file);
    else if (entry.isFile()) yield file;
    else throw new Error(`Unexpected non-regular Graphify payload file: ${file}`);
  }
}

export async function assertArchitecture(file, target) {
  const fd = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(64);
    await fd.read(head, 0, head.length, 0);
    let match;
    if (target === 'win32-x64' && head.toString('ascii', 0, 2) === 'MZ') {
      const pe = Buffer.alloc(6);
      const offset = head.readUInt32LE(0x3c);
      await fd.read(pe, 0, pe.length, offset);
      match = pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x8664;
    } else if (target === 'linux-x64') {
      match = head.readUInt32BE(0) === 0x7f454c46 && head[4] === 2 && head[5] === 1 && head.readUInt16LE(18) === 0x3e;
    } else if (target.startsWith('darwin-')) {
      const cpu = target === 'darwin-arm64' ? 0x100000c : 0x1000007;
      // NumPy's libgcc dylib has a fat header around a single Mach-O slice.
      if (head.readUInt32BE(0) === 0xcafebabe && head.readUInt32BE(4) === 1 && head.readUInt32BE(8) === cpu) {
        const offset = head.readUInt32BE(16);
        head.fill(0);
        await fd.read(head, 0, head.length, offset);
      }
      match = head.readUInt32LE(0) === 0xfeedfacf && head.readUInt32LE(4) === cpu;
    }
    if (!match) throw new Error(`Wrong binary format or CPU for ${target}: ${file}`);
  } finally {
    await fd.close();
  }
}

export async function assertPayload(directory, plan) {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(directory, manifestName), 'utf8'));
    if (receipt.target !== plan.target || receipt.lockSha256 !== plan.lockSha256) throw new Error('stale or wrong-architecture receipt');
    const required = [
      'launch.py', 'THIRD_PARTY_NOTICES.md', plan.target === 'win32-x64' ? 'python/LICENSE.txt' : 'python/lib/python3.12/LICENSE.txt',
      'licenses/LICENSE',
      ...Array.from(plan.packages.values()).flatMap(({ stem, notice }) => [
        `vendor/${stem}.dist-info/METADATA`, ...(notice ? [`licenses/${notice}`] : []),
      ]),
    ];
    for (const rel of required) if (!(await fs.lstat(path.join(directory, rel))).isFile()) throw new Error(`not a regular file: ${rel}`);
    await assertArchitecture(pythonExe(directory, plan.target), plan.target);
    return receipt;
  } catch (e) {
    throw new Error(`Missing or invalid Graphify payload for ${plan.target} at ${directory}: ${e.message}`);
  }
}

async function assemble(plan, directory) {
  await unpackPython(plan, directory);
  const vendor = path.join(directory, 'vendor');
  for (const pkg of plan.packages.values()) await unpackWheel(vendor, pkg);
  for (const file of ['launch.py', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(sources, file), path.join(directory, file));
  await fs.cp(path.join(sources, 'licenses'), path.join(directory, 'licenses'), { recursive: true });
  let size = 0;
  let count = 0;
  for await (const file of filesIn(directory)) {
    size += (await fs.stat(file)).size;
    count++;
    if (/\.(exe|dll|pyd|dylib|so(?:\.\d+)*)$/i.test(file)) await assertArchitecture(file, plan.target);
  }
  await fs.writeFile(path.join(directory, manifestName), `${JSON.stringify({
    target: plan.target, lockSha256: plan.lockSha256, pythonVersion: plan.python,
    graphifyVersion: plan.packages.get('graphifyy').version, size, count,
  }, null, 2)}\n`);
  await assertPayload(directory, plan);
  console.log(`Graphify ${plan.target}: ${(size / MiB).toFixed(1)} MiB (${count} files)`);
}

async function makeStage(parent, plan) {
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(path.join(parent, `.graphify-${plan.target}-`));
  try {
    await assemble(plan, stage);
    return stage;
  } catch (e) {
    await rm(stage);
    throw new Error(`Graphify preflight (${plan.target}): ${e.message}`, { cause: e });
  }
}

export async function prepare(target = host) {
  const plan = await loadPlan(target);
  const stage = await makeStage(devRoot, plan);
  const destination = path.join(devRoot, target);
  try {
    await rm(destination);
    await fs.rename(stage, destination);
    console.log(`Staged ${destination}`);
  } finally {
    await rm(stage);
  }
}

// A stage is consumed exactly once for this packager / output architecture. Do
// not take installer input from a previous build or the developer's staged tree.
const pending = new WeakMap();

export async function beforePack(context) {
  const plan = await loadPlan(`${context.electronPlatformName}-${Arch[context.arch]}`);
  const stage = await makeStage(context.outDir, plan);
  context.packager.info.disposeOnBuildFinish(() => rm(stage));
  if (!pending.has(context.packager)) pending.set(context.packager, new Map());
  pending.get(context.packager).set(context.appOutDir, { stage, plan });
}

export async function afterPack(context) {
  const builds = pending.get(context.packager);
  const entry = builds?.get(context.appOutDir);
  if (!entry || entry.plan.target !== `${context.electronPlatformName}-${Arch[context.arch]}`) {
    throw new Error(`No verified Graphify stage for ${context.appOutDir}`);
  }
  builds.delete(context.appOutDir);
  await assertPayload(entry.stage, entry.plan);
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'graphify-runtime');
  // Same build filesystem: move the verified payload into real resources
  // before signing and archiving, without another extraction or copy.
  await fs.rename(entry.stage, destination);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target, ...rest] = process.argv.slice(2);
  try {
    if (command !== 'prepare' || rest.length) throw new Error('Usage: node scripts/graphify-runtime.mjs prepare [platform-arch]');
    await prepare(target);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
