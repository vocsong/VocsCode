import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedSkillsStore } from '../src/main/shared-skills';
import type { HarnessId } from '../src/shared/harness-types';
import {
  MAX_SHARED_SKILL_COMMAND_CHARS, SHARED_SKILL_NAME, isSharedSkillCommand, parseSharedSkillCommand, sharedSkillSupported
} from '../src/shared/shared-skills';

const digest = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const markdown = (name: string, body = '\nDescribe a blue tile.\n', description = 'A museum guide') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

function gate() {
  let open!: () => void;
  const reached = new Promise<void>((resolve) => { open = resolve; });
  return { reached, open };
}

describe('Shared Skill command contract', () => {
  it('owns only the exact /skill token and preserves literal arguments after one delimiter', () => {
    expect(parseSharedSkillCommand('/skill a')).toEqual({ name: 'a', args: '' });
    expect(parseSharedSkillCommand('/skill\t blue-tile   arg  \n# next ')).toEqual({ name: 'blue-tile', args: '  arg  \n# next ' });
    expect(parseSharedSkillCommand('/skill 2-guide\r\n\n  /example')).toEqual({ name: '2-guide', args: '\n  /example' });
    for (const text of ['/skills a', '/skill:a', '//skill a', ' /skill a', '/Skill a', 'What is /skill a?']) {
      expect(isSharedSkillCommand(text)).toBe(false);
      expect(parseSharedSkillCommand(text)).toBeNull();
    }
    for (const text of ['/skill', '/skill   ', '/skill\nname', '/skill ../../name', '/skill BAD', '/skill a--b']) {
      expect(isSharedSkillCommand(text)).toBe(true);
      expect(parseSharedSkillCommand(text)).toBeNull();
    }
    const prefix = '/skill a ';
    const largest = prefix + 'x'.repeat(MAX_SHARED_SKILL_COMMAND_CHARS - prefix.length);
    expect(parseSharedSkillCommand(largest)?.args).toHaveLength(largest.length - prefix.length);
    expect(parseSharedSkillCommand(largest + 'x')).toBeNull();
  });

  it('validates Agent Skills names and allows only the eligible harnesses', () => {
    for (const name of ['0', '3d-model', 'a'.repeat(64)]) expect(SHARED_SKILL_NAME.test(name)).toBe(true);
    for (const name of ['', 'a'.repeat(65), 'a\n', '-a', 'a-', 'a--b', 'A', 'a_b', 'a.b', 'éclair']) expect(SHARED_SKILL_NAME.test(name)).toBe(false);
    const harnesses: HarnessId[] = ['codex', 'codex-exec', 'claude', 'pi', 'antigravity', 'cursor', 'acp', 'native'];
    expect(harnesses.filter(sharedSkillSupported)).toEqual(['codex', 'codex-exec', 'claude', 'pi', 'antigravity']);
  });
});

describe('SharedSkillsStore', () => {
  let tmp: string;
  let home: string;
  let root: string;
  let approvalFile: string;
  let store: SharedSkillsStore;
  const skillFile = (name: string) => path.join(root, name, 'SKILL.md');
  const reopen = () => new SharedSkillsStore(approvalFile, root);
  const seed = async (name: string, raw: string | Buffer = markdown(name)) => {
    const file = skillFile(name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, raw);
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'vocs-shared-skills-'));
    home = path.join(tmp, 'home');
    await fs.mkdir(home);
    root = path.join(home, '.agents', 'skills');
    approvalFile = path.join(tmp, 'profile', 'shared-skills.json');
    store = reopen();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('defaults to the single global root, sorts metadata, and ignores other harness roots', async () => {
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const defaultStore = new SharedSkillsStore(approvalFile);
    for (const parent of ['.claude', '.codex', path.join('.pi', 'agent')]) {
      const dir = path.join(home, parent, 'skills', 'native-guide');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), markdown('native-guide'));
    }
    await expect(defaultStore.list()).resolves.toEqual([]);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    const first = markdown('a', '\nPRIVATE BODY SENTINEL\n');
    const last = markdown('z', '\nLast.\n', 'Other guide');
    await seed('z', last);
    await seed('a', first);
    await seed('broken', 'not a skill');
    await seed('nested-guide', markdown('nested-guide'));
    await fs.rename(path.join(root, 'nested-guide'), path.join(root, 'a', 'nested-guide'));
    expect(await defaultStore.list()).toEqual([
      { name: 'a', description: 'A museum guide', revision: digest(first), reviewed: false },
      { name: 'z', description: 'Other guide', revision: digest(last), reviewed: false }
    ]);
    await expect(defaultStore.read('native-guide')).rejects.toThrow(/not found/i);
    await expect(defaultStore.resolve('nested-guide')).rejects.toThrow(/not found/i);
  });

  it('does not create the home directory while provisioning the default catalog', async () => {
    const missingHome = path.join(tmp, 'missing-home');
    vi.stubEnv('HOME', missingHome);
    vi.stubEnv('USERPROFILE', missingHome);
    const defaultStore = new SharedSkillsStore(approvalFile);
    await expect(defaultStore.list()).resolves.toEqual([]);
    await expect(defaultStore.create({ name: 'a', description: 'A guide' })).rejects.toThrow(/directories without links/);
    await expect(fs.lstat(missingHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists only the opted-in raw digest and resolves the exact body across reopen', async () => {
    const name = 'museum-guide';
    const body = '\r\n# Façade 🖼\r\n\r\n  Keep this space.  \r\n---\r\nMore Markdown.\r\n';
    const raw = '\uFEFF---\r\nname: \'museum-guide\'\r\ndescription: "A \\"tile\\" guide"\r\n---\r\n' + body;
    await seed(name, raw);
    const receipt = { name, revision: digest(raw) };
    const meta = { ...receipt, description: 'A "tile" guide' };
    await expect(store.read(name)).resolves.toEqual({ ...meta, reviewed: false, content: raw });
    await expect(store.resolve(name)).rejects.toThrow(/not reviewed/i);
    await expect(fs.lstat(approvalFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.review({ ...receipt, enabled: true })).resolves.toEqual({ ...meta, reviewed: true });
    expect(JSON.parse(await fs.readFile(approvalFile, 'utf8'))).toEqual({ version: 1, approvals: { [name]: receipt.revision } });
    expect(await fs.readFile(skillFile(name), 'utf8')).toBe(raw);
    await expect(reopen().list()).resolves.toEqual([{ ...meta, reviewed: true }]);
    await expect(reopen().resolve(name)).resolves.toEqual({ receipt, content: body });
    if (process.platform !== 'win32') {
      expect((await fs.stat(approvalFile)).mode & 0o777).toBe(0o600);
      await fs.chmod(approvalFile, 0o644);
      await expect(reopen().resolve(name)).rejects.toThrow(/approvals are unavailable/i);
      await fs.chmod(approvalFile, 0o600);
    }

    const disabling = store.review({ ...receipt, enabled: false });
    const denied = expect(store.resolve(name)).rejects.toThrow(/not reviewed/i);
    await expect(disabling).resolves.toEqual({ ...meta, reviewed: false });
    await denied;
    await expect(reopen().resolve(name)).rejects.toThrow(/not reviewed/i);
    expect(JSON.parse(await fs.readFile(approvalFile, 'utf8'))).toEqual({ version: 1, approvals: {} });
  });

  it('invalidates an external raw-byte edit and refuses to approve or overwrite a stale revision', async () => {
    const name = 'a';
    await seed(name);
    const { revision } = await store.read(name);
    const review = { name, revision, enabled: true };
    await store.review(review);
    const committed = await fs.readFile(approvalFile, 'utf8');
    // The body did not change; even this edit to the raw frontmatter needs fresh review.
    const external = markdown(name, '\nDescribe a blue tile.\n', '"A museum guide"');
    await fs.writeFile(skillFile(name), external);
    await expect(store.resolve(name)).rejects.toThrow(/changed.*review/i);
    await expect(store.read(name)).resolves.toMatchObject({ revision: digest(external), content: external, reviewed: false });
    await expect(store.review(review)).rejects.toThrow(/changed on disk/i);
    await expect(store.save({ name, revision, content: markdown(name, '\nEditor draft.\n') })).rejects.toThrow(/changed on disk/i);
    expect(await fs.readFile(skillFile(name), 'utf8')).toBe(external);
    expect(await fs.readFile(approvalFile, 'utf8')).toBe(committed);
    await expect(store.review({ ...review, revision: digest(external) })).resolves.toMatchObject({ reviewed: true });
    expect(await fs.readFile(skillFile(name), 'utf8')).toBe(external);
    await fs.unlink(skillFile(name));
    await expect(store.resolve(name)).rejects.toThrow(/not found/i);
  });

  it('creates an editable, unreviewed scaffold without clobbering a colliding name', async () => {
    const req = { name: 'blue-2', description: 'Say "blue": tile\nand mosaic' };
    const results = await Promise.allSettled([store.create(req), reopen().create(req)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { message: 'Shared skill already exists.' } });
    const created = await store.read(req.name);
    expect(created).toEqual({ name: req.name, description: 'Say "blue": tile and mosaic', revision: digest(created.content), reviewed: false, content: created.content });
    expect(created.content).toContain(`# ${req.name}\n`);
    expect(await fs.readFile(skillFile(req.name), 'utf8')).toBe(created.content);
    await expect(store.resolve(req.name)).rejects.toThrow(/not reviewed/i);
    await expect(store.create({ name: 'empty', description: '\t \n' })).rejects.toThrow(/description/i);
    await expect(store.create({ name: 'empty', description: 'a'.repeat(1025) })).rejects.toThrow(/description/i);
    const ownedElsewhere = path.join(root, 'empty');
    await fs.mkdir(ownedElsewhere);
    await expect(store.create({ name: 'empty', description: 'A guide' })).rejects.toThrow(/already exists/i);
    expect(await fs.readdir(ownedElsewhere)).toEqual([]);
  });

  it('keeps the original bytes and review on failed atomic save, then recovers without auto-reviewing edits', async () => {
    const name = 'a';
    const original = markdown(name);
    await seed(name, original);
    const file = skillFile(name);
    if (process.platform !== 'win32') await fs.chmod(file, 0o640);
    const prior = await fs.stat(file);
    const request = { name, revision: digest(original), content: markdown(name, '\nPrivate new draft.\n') };
    await store.review({ name, revision: request.revision, enabled: true });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error(`cannot rename ${file}: ${request.content}`));
    await expect(store.save(request)).rejects.toThrow(/^Could not save shared skill\.$/);
    rename.mockRestore();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readdir(path.dirname(file))).toEqual(['SKILL.md']);
    await expect(store.resolve(name)).resolves.toMatchObject({ receipt: { revision: request.revision } });
    const otherDraft = markdown(name, '\nOther editor.\n');
    const first = store.save(request);
    const stale = expect(store.save({ ...request, content: otherDraft })).rejects.toThrow(/changed on disk/i);
    await expect(first).resolves.toMatchObject({ revision: digest(request.content), content: request.content, reviewed: false });
    await stale;
    expect(await fs.readFile(file, 'utf8')).toBe(request.content);
    expect(await fs.readdir(path.dirname(file))).toEqual(['SKILL.md']);
    const final = await fs.stat(file);
    expect({ mode: final.mode, uid: final.uid, gid: final.gid }).toEqual({ mode: prior.mode, uid: prior.uid, gid: prior.gid });
    await expect(reopen().resolve(name)).rejects.toThrow(/changed/i);
  });

  it('detects a competing disk edit made while staging a save', async () => {
    await seed('a');
    const file = skillFile('a');
    const external = markdown('a', '\nOther process.\n');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (flags === 'wx') await fs.writeFile(file, external);
      return open(target, flags, mode);
    });
    await expect(store.save({ name: 'a', revision: digest(markdown('a')), content: markdown('a', '\nLocal draft.\n') })).rejects.toThrow(/changed on disk/i);
    expect(await fs.readFile(file, 'utf8')).toBe(external);
    expect(await fs.readdir(path.dirname(file))).toEqual(['SKILL.md']);
  });

  it('serializes reviews, publishes nothing on a failed commit, then retains both approvals on recovery', async () => {
    await seed('a');
    await seed('b');
    const alpha = { name: 'a', revision: digest(markdown('a')), enabled: true };
    const beta = { name: 'b', revision: digest(markdown('b')), enabled: true };
    const staged = gate();
    const release = gate();
    vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      staged.open();
      await release.reached;
      throw new Error(`private profile path ${approvalFile}`);
    });
    const failed = expect(store.review(alpha)).rejects.toThrow(/^Could not save shared skill review\.$/);
    // Do not let a regression before the rename hang the test waiting for the gate.
    await Promise.race([staged.reached, failed.then(() => { throw new Error('Review failed before commit.'); })]);
    const queued = store.review(beta);
    try {
      await expect(store.read('a')).resolves.toMatchObject({ reviewed: false });
      await expect(reopen().resolve('a')).rejects.toThrow(/not reviewed/i);
      await expect(fs.lstat(approvalFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release.open();
    }
    await failed;
    await expect(queued).resolves.toMatchObject({ name: 'b', reviewed: true });
    expect(await fs.readdir(path.dirname(approvalFile))).toEqual(['shared-skills.json']);
    await expect(store.review(alpha)).resolves.toMatchObject({ name: 'a', reviewed: true });
    await expect(reopen().list()).resolves.toEqual([
      { name: 'a', revision: alpha.revision, description: 'A museum guide', reviewed: true },
      { name: 'b', revision: beta.revision, description: 'A museum guide', reviewed: true }
    ]);
  });

  it('fails closed if persisted approvals are malformed, without hiding documents or overwriting the profile', async () => {
    await seed('a');
    const review = { name: 'a', revision: digest(markdown('a')), enabled: true };
    await store.review(review);
    const malformed = '{"approvals":"PRIVATE PROFILE SENTINEL"';
    await fs.writeFile(approvalFile, malformed);
    await expect(store.read('a')).resolves.toMatchObject({ reviewed: false });
    await expect(store.resolve('a')).rejects.toThrow(/^Shared skill approvals are unavailable\.$/);
    await expect(store.review(review)).rejects.toThrow(/^Shared skill approvals are unavailable\.$/);
    expect(await fs.readFile(approvalFile, 'utf8')).toBe(malformed);
    await fs.unlink(approvalFile);
    await expect(store.review(review)).resolves.toMatchObject({ reviewed: true });
  });

  it.each([
    ['mismatched name', markdown('different')],
    ['missing name', '---\ndescription: A guide\n---\nRead this.'],
    ['missing description', '---\nname: a\n---\nRead this.'],
    ['duplicate name', '---\nname: a\nname: a\ndescription: A guide\n---\nRead this.'],
    ['duplicate description', '---\nname: a\ndescription: A guide\ndescription: A guide\n---\nRead this.'],
    ['ambiguous YAML', markdown('a', '\nBody.\n', '{name: other}')],
    ['bad quote', markdown('a', '\nBody.\n', '"not closed')],
    ['missing delimiter', '---\nname: a\ndescription: A guide\n\nRead this.'],
    ['unsupported extra frontmatter', '---\nname: a\ndescription: A guide\nlicense: MIT\n---\nRead this.'],
    ['empty body', markdown('a', '\n\t \u200B\n')],
    ['binary text', markdown('a', '\nBody.\0\n')]
  ])('rejects %s both on disk and before saving', async (_, invalid) => {
    await seed('a');
    await expect(store.save({ name: 'a', revision: digest(markdown('a')), content: invalid })).rejects.toThrow(/^Shared skill /);
    expect(await fs.readFile(skillFile('a'), 'utf8')).toBe(markdown('a'));
    await seed('a', invalid);
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.review({ name: 'a', revision: digest(invalid), enabled: true })).rejects.toThrow(/^Shared skill /);
    await expect(store.resolve('a')).rejects.toThrow(/^Shared skill /);
  });

  it('accepts scalar quoting and a folded description without changing the document bytes', async () => {
    const raw = '---\n# Simple safe subset\ndescription: >-\n  A guide to the museum\n  and the mosaic.\nname: "a" # same as the folder\n---\n\nRead this.\n';
    await seed('a', raw);
    await expect(store.read('a')).resolves.toEqual({ name: 'a', revision: digest(raw), description: 'A guide to the museum and the mosaic.', reviewed: false, content: raw });
  });

  it('enforces the byte cap and refuses malformed UTF-8 in disk bytes or editor text', async () => {
    const header = markdown('a', '');
    const last = header + 'x'.repeat(32 * 1024 - Buffer.byteLength(header));
    await seed('a', last);
    await expect(store.read('a')).resolves.toMatchObject({ revision: digest(last) });
    await expect(store.save({ name: 'a', revision: digest(last), content: header + 'é'.repeat(17_000) })).rejects.toThrow(/32 KiB/);
    await expect(store.save({ name: 'a', revision: digest(last), content: header + '\uD800' })).rejects.toThrow(/valid UTF-8/);
    await seed('a', `${last}x`);
    await expect(store.read('a')).rejects.toThrow(/32 KiB/);
    await seed('a', Buffer.concat([Buffer.from(header), Buffer.from([0xc3, 0x28])]));
    await expect(store.read('a')).rejects.toThrow(/valid UTF-8/);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('refuses path inputs and noncanonical skill folder or filename casing', async () => {
    for (const name of ['../a', '../elsewhere/a', 'a/b', 'a\\b', 'a:alt', 'a\n', 'a--b', path.join(tmp, 'a')]) {
      await expect(store.create({ name, description: 'A guide' })).rejects.toThrow(/^Invalid shared skill name\.$/);
      await expect(store.resolve(name)).rejects.toThrow(/^Invalid shared skill name\.$/);
    }
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await seed('CaSe', markdown('case'));
    await fs.mkdir(path.join(root, 'filename'));
    await fs.writeFile(path.join(root, 'filename', 'skill.md'), markdown('filename'));
    await expect(store.read('case')).rejects.toThrow();
    await expect(store.read('filename')).rejects.toThrow();
    await expect(store.list()).resolves.toEqual([]);
  });

  const linkDir = (target: string, at: string) => fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');

  it.each(['.agents ancestor', 'skills root'])('refuses a linked %s without mutating the target', async (linked) => {
    const outside = path.join(tmp, 'outside');
    const at = linked === '.agents ancestor' ? path.dirname(root) : root;
    const target = linked === '.agents ancestor' ? path.join(outside, 'skills') : outside;
    await fs.mkdir(path.join(target, 'a'), { recursive: true });
    await fs.writeFile(path.join(target, 'a', 'SKILL.md'), markdown('a'));
    await fs.mkdir(path.dirname(at), { recursive: true });
    await linkDir(outside, at);
    await expect(store.list()).rejects.toThrow(/^Shared skills require regular files and directories without links\.$/);
    await expect(store.create({ name: 'b', description: 'A guide' })).rejects.toThrow(/without links/);
    await expect(store.resolve('a')).rejects.toThrow(/without links/);
    expect(await fs.readdir(target)).toEqual(['a']);
  });

  it('refuses linked skill folders and files even for previously reviewed bytes', async () => {
    await seed('a');
    await seed('b');
    const alpha = { name: 'a', revision: digest(markdown('a')), enabled: true };
    const beta = { name: 'b', revision: digest(markdown('b')), enabled: true };
    await store.review(alpha);
    await store.review(beta);
    const outside = path.join(tmp, 'outside');
    const target = path.join(outside, 'SKILL.md');
    await fs.rename(path.dirname(skillFile('a')), outside);
    await linkDir(outside, path.dirname(skillFile('a')));
    await fs.unlink(skillFile('b'));
    const hardTarget = path.join(tmp, 'hard-target.md');
    await fs.writeFile(hardTarget, markdown('b'));
    await fs.link(hardTarget, skillFile('b'));
    if (process.platform !== 'win32') {
      await fs.mkdir(path.join(root, 'c'));
      await fs.symlink(hardTarget, skillFile('c'));
      await expect(store.read('c')).rejects.toThrow(/without links/);
    }
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.resolve('a')).rejects.toThrow(/without links/);
    await expect(store.resolve('b')).rejects.toThrow(/without links/);
    await expect(store.review(beta)).rejects.toThrow(/without links/);
    await expect(store.save({ ...beta, content: markdown('b', '\nOther.\n') })).rejects.toThrow(/without links/);
    await expect(store.create({ name: 'a', description: 'A guide' })).rejects.toThrow(/already exists/i);
    expect(await fs.readFile(target, 'utf8')).toBe(markdown('a'));
    expect(await fs.readFile(hardTarget, 'utf8')).toBe(markdown('b'));
  });

  it('does not take reviews from a linked profile', async () => {
    await seed('a');
    const review = { name: 'a', revision: digest(markdown('a')), enabled: true };
    await store.review(review);
    const alias = path.join(tmp, 'profile-link');
    await linkDir(path.dirname(approvalFile), alias);
    const linkedProfile = new SharedSkillsStore(path.join(alias, path.basename(approvalFile)), root);
    await expect(linkedProfile.read('a')).resolves.toMatchObject({ reviewed: false });
    await expect(linkedProfile.resolve('a')).rejects.toThrow(/without links/);
    await expect(linkedProfile.review(review)).rejects.toThrow(/without links/);
    await expect(store.resolve('a')).resolves.toMatchObject({ receipt: { revision: review.revision } });
  });

  it('bounds enumeration even when the excess entries are not skills', async () => {
    await seed('a');
    for (let i = 0; i < 8; i++) {
      await Promise.all(Array.from({ length: 64 }, (_, j) => fs.writeFile(path.join(root, `.${i}-${j}`), '')));
    }
    await expect(store.list()).rejects.toThrow(/^Shared skills directory has too many entries\.$/);
    await expect(store.read('a')).resolves.toMatchObject({ name: 'a' });
  });
});
