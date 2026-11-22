import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { afterPack, assertArchitecture, assertPayload, getArtifact, loadPlan, readPlan, triples } from './graphify-runtime.mjs';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
const { Arch } = builderRequire('builder-util');
const { load } = builderRequire('js-yaml');
const lock = JSON.parse(await fs.readFile(new URL('../resources/graphify/artifacts.lock.json', import.meta.url), 'utf8'));

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphify-build-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('each builder target has the complete pinned non-extra wheel set and its own interpreter', async () => {
  const config = load(await fs.readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
  assert.equal(config.beforePack, './scripts/graphify-runtime.mjs');
  assert.equal(config.afterPack, './scripts/graphify-runtime.mjs');
  assert.deepEqual(config.publish, { provider: 'github', releaseType: 'draft' });
  const targets = new Set();
  for (const [key, platform] of [['win', 'win32'], ['mac', 'darwin'], ['linux', 'linux']]) {
    for (const target of config[key].target) for (const arch of target.arch) targets.add(`${platform}-${arch}`);
  }
  assert.deepEqual(targets, new Set(Object.keys(triples)));
  const distros = new Set();
  for (const target of targets) {
    const plan = await loadPlan(target);
    assert.equal(plan.packages.get('graphifyy').version, '0.9.115');
    assert.equal(plan.packages.size, 31);
    distros.add(plan.distro.sha256);
  }
  assert.equal(distros.size, targets.size);
});

test('preflight refuses unpinned, incompatible and unsupported artifacts before fetching', () => {
  assert.throws(() => readPlan(lock, 'darwin-universal'), /No locked runtime/);
  const wrongDistro = structuredClone(lock);
  wrongDistro.python.artifacts['darwin-arm64'] = lock.python.artifacts['darwin-x64'];
  assert.throws(() => readPlan(wrongDistro, 'darwin-arm64'), /Unexpected Python standalone archive/);
  const wrongWheel = structuredClone(lock);
  const wheels = wrongWheel.wheels.find((w) => w.name === 'numpy').artifacts;
  wheels['darwin-arm64'] = wheels['darwin-x64'];
  assert.throws(() => readPlan(wrongWheel, 'darwin-arm64'), /incompatible with CPython 3.12/);
  const newerOs = structuredClone(lock);
  const armWheel = newerOs.wheels.find((w) => w.name === 'numpy').artifacts['darwin-arm64'];
  armWheel.url = armWheel.url.replace('macosx_11_0', 'macosx_14_0');
  assert.throws(() => readPlan(newerOs, 'darwin-arm64'), /incompatible with CPython 3.12/);
  const unlocked = structuredClone(lock);
  delete unlocked.wheels[0].artifacts.any.sha256;
  assert.throws(() => readPlan(unlocked, 'win32-x64'), /valid SHA-256/);
});

test('wrong download never becomes a cache entry, and cached bytes are rehashed', async (t) => {
  const cache = await temp(t);
  const good = Buffer.from('verified');
  const bad = Buffer.from('modified'); // same size, so length validation alone is insufficient
  const artifact = { url: 'https://files.pythonhosted.org/fixture.whl', size: good.length,
    sha256: createHash('sha256').update(good).digest('hex') };
  const file = path.join(cache, artifact.sha256);
  await assert.rejects(getArtifact(artifact, cache, async () => bad), /SHA-256 mismatch/);
  assert.deepEqual(await fs.readdir(cache), []);
  assert.deepEqual(await getArtifact(artifact, cache, async () => good), good);
  const unexpectedDownload = async () => assert.fail('must not download again for a cache entry');
  assert.deepEqual(await getArtifact(artifact, cache, unexpectedDownload), good);
  await fs.writeFile(file, bad);
  await assert.rejects(getArtifact(artifact, cache, unexpectedDownload), /Unverified Graphify cache entry/);
});

test('pack hook will not use a stale payload and validator requires the current receipt and files', async (t) => {
  const dir = await temp(t);
  const payload = path.join(dir, 'resources/graphify-runtime');
  await fs.mkdir(payload, { recursive: true });
  const plan = await loadPlan('win32-x64');
  const check = () => assertPayload(payload, plan);
  await assert.rejects(check(), /Missing or invalid Graphify payload/);
  const receipt = path.join(payload, 'runtime.json');
  await fs.writeFile(receipt, JSON.stringify({ target: plan.target, lockSha256: 'previous' }));
  await assert.rejects(check(), /stale or wrong-architecture receipt/);
  await fs.writeFile(receipt, JSON.stringify({ target: plan.target, lockSha256: plan.lockSha256 }));
  await assert.rejects(check(), /launch\.py/);
  await assert.rejects(afterPack({ appOutDir: dir, electronPlatformName: 'win32', arch: Arch.x64,
    packager: { getResourcesDir: () => path.join(dir, 'resources') } }), /No verified Graphify stage/);
});

test('cross staging checks actual machine headers, including a single-slice fat Mach-O', async (t) => {
  const dir = await temp(t);
  const machFile = path.join(dir, 'binding.so');
  const mach = Buffer.alloc(128);
  mach.writeUInt32BE(0xcafebabe, 0);
  mach.writeUInt32BE(1, 4);
  mach.writeUInt32BE(0x100000c, 8);
  mach.writeUInt32BE(64, 16);
  mach.writeUInt32LE(0xfeedfacf, 64);
  mach.writeUInt32LE(0x100000c, 68);
  await fs.writeFile(machFile, mach);
  await assertArchitecture(machFile, 'darwin-arm64');
  await assert.rejects(assertArchitecture(machFile, 'darwin-x64'), /Wrong binary format or CPU/);
  mach.writeUInt32LE(0x1000007, 68);
  await fs.writeFile(machFile, mach);
  await assert.rejects(assertArchitecture(machFile, 'darwin-arm64'), /Wrong binary format or CPU/);
});
