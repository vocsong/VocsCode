import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { assertPayload, devRoot, host, loadPlan, pythonExe } from './graphify-runtime.mjs';

const run = promisify(execFile);
const flags = ['-I', '-S', '-B'];
const outputs = {
  'win32-x64': 'win-unpacked/resources',
  'linux-x64': 'linux-unpacked/resources',
  'darwin-x64': 'mac/Vocs Code.app/Contents/Resources',
  'darwin-arm64': 'mac-arm64/Vocs Code.app/Contents/Resources',
};

async function canRun(target) {
  if (target === host) return true;
  if (host !== 'darwin-arm64' || target !== 'darwin-x64') return false;
  // Cross-staging must not require Rosetta. Use it for the smoke only if it is
  // already installed; never trigger installation on the build machine.
  return run('/usr/sbin/pkgutil', ['--pkg-info', 'com.apple.pkg.RosettaUpdateAuto'], { timeout: 5_000 })
    .then(() => true, () => false);
}

async function smoke(directory, target) {
  const plan = await loadPlan(target);
  const receipt = await assertPayload(directory, plan);
  if (!(await canRun(target))) {
    console.log(`${target}: packaged payload/architecture verified; cannot execute on ${host}`);
    return;
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vocs graphify smoke-'));
  try {
    const project = path.join(temporary, 'sample café');
    const output = path.join(temporary, 'output cache');
    const intruder = 'raise RuntimeError("unexpected module loaded from outside runtime")\n';
    for (const dir of [project, path.join(project, '.vocs-code'), path.join(temporary, '.git/objects'), path.join(temporary, '.git/refs')]) {
      await fs.mkdir(dir, { recursive: true });
    }
    await Promise.all([
      fs.writeFile(path.join(temporary, '.git/HEAD'), 'ref: refs/heads/main\n'),
      fs.writeFile(path.join(temporary, '.graphifyignore'), 'probe.ts\n'),
      fs.writeFile(path.join(project, 'probe.ts'), 'export function offlineGraphifyProbe() { return 42; }\n'),
      fs.writeFile(path.join(project, 'second.py'), 'def second_probe():\n    return 43\n'),
      fs.writeFile(path.join(project, '.gitignore'), 'omitted.ts\n'),
      fs.writeFile(path.join(project, 'omitted.ts'), 'export function mustNotIndex() {}\n'),
      fs.writeFile(path.join(project, '.vocs-code/omitted.ts'), 'export function alsoMustNotIndex() {}\n'),
      fs.writeFile(path.join(project, 'sitecustomize.py'), intruder),
      fs.writeFile(path.join(project, 'graphify.py'), intruder),
      fs.writeFile(path.join(project, 'numpy.py'), intruder),
      // Exceed upstream's parallel threshold while using the single-core desktop port.
      ...Array.from({ length: 24 }, (_, i) => fs.writeFile(path.join(project, `additional${i}.py`), `def worker_probe_${i}():\n    return ${i}\n`)),
    ]);
    const opt = {
      cwd: project,
      env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        PATH: '', PYTHONPATH: project, PYTHONHOME: project, PYTHONUSERBASE: project,
        HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary,
        TMP: temporary, TEMP: temporary, TMPDIR: temporary, GRAPHIFY_MAX_WORKERS: '2',
      },
      timeout: 60_000, windowsHide: true,
    };
    const python = pythonExe(directory, target);
    const launch = [ ...flags, path.join(directory, 'launch.py') ];
    const result = await run(python, [...launch, '--version'], opt);
    assert.equal(result.stdout.trim(), `graphify ${receipt.graphifyVersion}`);
    await assert.rejects(run(python, [...launch, 'hook', 'install'], opt), { code: 2 });
    const extract = ['extract', project, '--code-only', '--exclude', '.vocs-code', '--out', output];
    await assert.rejects(run(python, [...launch, ...extract, '--backend', 'openai'], opt), { code: 2 });
    // Validate every pinned distribution and import its native modules from
    // the same isolated search roots. A pure-Python version probe cannot do this.
    const imports = [...plan.packages.keys()].map((name) => ({ graphifyy: 'graphify', pyyaml: 'yaml' }[name] ?? name.replaceAll('-', '_')));
    const probe = `
import importlib, json, sys
from importlib.metadata import distributions
from pathlib import Path
vendor = Path(sys.argv[1]).resolve()
expected, modules = json.loads(sys.argv[2])
assert '.'.join(map(str, sys.version_info[:3])) == sys.argv[3], sys.version
assert sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode
sys.path.append(str(vendor))
installed = {d.metadata['Name'].lower().replace('_', '-'): d.version for d in distributions(path=[str(vendor)])}
assert installed == expected, installed
for name in modules:
    module = importlib.import_module(name)
    assert Path(module.__file__).resolve().is_relative_to(vendor), module.__file__
import yaml._yaml, rapidfuzz.fuzz_cpp, numpy._core._multiarray_umath
`;
    const expected = Object.fromEntries([...plan.packages.values()].map(({ name, version }) => [name, version]));
    await run(python, [...flags, '-c', probe, path.join(directory, 'vendor'), JSON.stringify([expected, imports]), plan.python], opt);
    const { stdout, stderr } = await run(python, [...launch, ...extract], opt);
    assert.doesNotMatch(stderr, /traceback|brokenprocesspool|worker failed/i, stdout);
    const graph = JSON.parse(await fs.readFile(path.join(output, 'graphify-out/graph.json'), 'utf8'));
    assert.ok(graph.nodes.some((node) => node.label?.includes('offlineGraphifyProbe')), 'TypeScript AST node missing');
    assert.ok(graph.nodes.some((node) => node.label?.includes('second_probe')), 'Python AST node missing');
    assert.equal(graph.nodes.filter((node) => /^worker_probe_\d+\(\)$/.test(node.label)).length, 24, 'larger extraction lost source files');
    assert.ok(graph.links.length > 0, 'graph edges missing');
    assert.ok(!graph.nodes.some((node) => node.source_file?.includes('omitted.ts')), 'ignored file was indexed');
    await assert.rejects(fs.access(path.join(project, 'graphify-out')), { code: 'ENOENT' });
    console.log(`${target}: Graphify ${receipt.graphifyVersion}, ${imports.length} wheel imports, offline extract (${graph.nodes.length} nodes)`);
  } finally {
    await fs.rm(temporary, { force: true, recursive: true, maxRetries: 3 });
  }
}

try {
  const { values: args } = parseArgs({ options: {
    packaged: { type: 'boolean' }, 'output-dir': { type: 'string', default: 'dist' },
    target: { type: 'string' }, payload: { type: 'string' },
  } });
  if (args.packaged && args.payload) throw new Error('Choose --packaged or --payload, not both');
  const targets = args.target ? [args.target] : args.packaged && process.platform === 'darwin'
    ? ['darwin-x64', 'darwin-arm64'] : [host];
  for (const target of targets) {
    if (!Object.hasOwn(outputs, target)) throw new Error(`Unsupported Graphify target: ${target}`);
    const directory = args.packaged
      ? path.resolve(args['output-dir'], outputs[target], 'graphify-runtime')
      : args.payload ? path.resolve(args.payload) : path.join(devRoot, target);
    await smoke(directory, target);
  }
} catch (e) {
  console.error(`Graphify smoke: ${e.message}`);
  if (e.stderr && !e.message.includes(e.stderr)) console.error(e.stderr);
  process.exitCode = 1;
}
