/**
 * Offline tests for harness process teardown: dispose/close must bring the child down before
 * it resolves, so app quit cannot race the kill (issue #121).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { JsonRpcStdioClient } from '../src/main/harness/jsonrpc';
import { killTree, shutdownChild } from '../src/main/harness/spawn';

const PIPES: SpawnOptions = { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };

function spawnIdle(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], PIPES);
}

function spawnExitOnStdinEnd(): ChildProcess {
  return spawn(process.execPath, ['-e', 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume(); process.stdout.write("ready\\n");'], PIPES);
}

const dead = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

function onceExit(child: ChildProcess): Promise<void> {
  if (dead(child)) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

describe('shutdownChild', () => {
  it('force-kills a child that outlives the grace period', async () => {
    const child = spawnIdle();
    await shutdownChild(child, 200);
    await onceExit(child);
    expect(dead(child)).toBe(true);
  });

  it('resolves once the child exits on stdin close, without waiting out the grace period', async () => {
    const child = spawnExitOnStdinEnd();
    const started = Date.now();
    await shutdownChild(child, 10_000);
    await onceExit(child);
    expect(dead(child)).toBe(true);
    expect(Date.now() - started).toBeLessThan(9_000);
  });

  it('is a no-op for a child that already exited', async () => {
    const child = spawn(process.execPath, ['-e', '0'], PIPES);
    await onceExit(child);
    await expect(killTree(child)).resolves.toBeUndefined();
    await expect(shutdownChild(child)).resolves.toBeUndefined();
  });
});

describe('JsonRpcStdioClient.close', () => {
  it('brings the child tree down before resolving', async () => {
    const child = spawnIdle();
    const rpc = new JsonRpcStdioClient(child);
    await rpc.close();
    await onceExit(child);
    expect(dead(child)).toBe(true);
  });
});
