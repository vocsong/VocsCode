/** Unit tests for the P4 remote audit trail (src/main/remote/audit.ts): a bounded, durable
 *  feed of pairing, connection, revocation and refusal events that must survive a reload and
 *  must never break the remote host when the disk is unwritable. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteAudit } from '../src/main/remote/audit';

const MAX_ENTRIES = 200;

describe('remote audit trail', () => {
  const dirs: string[] = [];

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vocs-audit-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('records newest first, persists to disk and reloads', async () => {
    const dir = await tmp();
    const audit = new RemoteAudit({ dir, log: () => undefined });
    await audit.load();
    audit.record('enable', { detail: 'wss://relay.example' });
    audit.record('pair-approve', { device: 'w_1' });
    audit.record('client-connect', { device: 'w_1' });
    await audit.flush();

    const listed = audit.list();
    expect(listed.map((e) => e.action)).toEqual(['client-connect', 'pair-approve', 'enable']);
    expect(listed[1]).toMatchObject({ action: 'pair-approve', device: 'w_1' });
    expect(typeof listed[0].at).toBe('number');

    const reloaded = new RemoteAudit({ dir, log: () => undefined });
    await reloaded.load();
    expect(reloaded.list().map((e) => e.action)).toEqual(['client-connect', 'pair-approve', 'enable']);
  });

  it('caps the feed and the file at the same bounded window', async () => {
    const dir = await tmp();
    const audit = new RemoteAudit({ dir, log: () => undefined });
    await audit.load();
    for (let i = 0; i < MAX_ENTRIES + 25; i++) audit.record('client-disconnect', { device: `w_${i}` });
    await audit.flush();

    expect(audit.list()).toHaveLength(MAX_ENTRIES);
    expect(audit.list()[0].device).toBe(`w_${MAX_ENTRIES + 24}`);
    expect(audit.list().at(-1)?.device).toBe('w_25');

    const reloaded = new RemoteAudit({ dir, log: () => undefined });
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(MAX_ENTRIES);
    expect(reloaded.list()[0].device).toBe(`w_${MAX_ENTRIES + 24}`);
  });

  it('clears the memory feed and the file', async () => {
    const dir = await tmp();
    const audit = new RemoteAudit({ dir, log: () => undefined });
    await audit.load();
    audit.record('enable');
    await audit.flush();
    audit.clear();
    await audit.flush();
    expect(audit.list()).toEqual([]);

    const reloaded = new RemoteAudit({ dir, log: () => undefined });
    await reloaded.load();
    expect(reloaded.list()).toEqual([]);
  });

  it('keeps recording in memory when the file cannot be written', async () => {
    const dir = await tmp();
    // A regular file where the audit directory should be: mkdir/append both fail.
    const blocked = path.join(dir, 'not-a-directory');
    await writeFile(blocked, 'x');
    const warnings: string[] = [];
    const audit = new RemoteAudit({ dir: blocked, log: (level, message) => warnings.push(`${level}:${message}`) });
    await audit.load();
    audit.record('pair-start');
    await audit.flush();

    expect(audit.list().map((e) => e.action)).toEqual(['pair-start']);
    expect(warnings.some((w) => w.startsWith('warn:'))).toBe(true);
  });
});
