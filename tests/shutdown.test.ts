/** Regression tests for graceful main-process shutdown ordering, isolation, and timeout cap. */
import { describe, expect, it, vi } from 'vitest';
import { RemoteHost } from '../src/main/remote/host';
import { runGracefulShutdown, type ShutdownTargets } from '../src/main/shutdown';

function makeTargets(overrides: Partial<ShutdownTargets> = {}) {
  const order: string[] = [];
  const log = vi.fn();
  const track = (name: string, fn?: () => unknown) =>
    vi.fn(() => {
      order.push(name);
      return fn?.();
    });
  const trackAsync = (name: string, fn?: () => Promise<unknown>) =>
    vi.fn(async () => {
      order.push(name);
      if (fn) await fn();
    });

  const targets: ShutdownTargets = {
    localControl: { shutdown: track('localControl.shutdown') },
    keepAwake: { quit: track('keepAwake.quit') },
    mission: { dispose: track('mission.dispose') },
    updater: { stopChecking: track('updater.stopChecking') },
    analyticsSync: { stop: track('analyticsSync.stop') },
    remoteHost: { close: track('remoteHost.close') },
    sessions: {
      list: () => [{ status: 'running' }, { status: 'idle' }],
      stopAll: trackAsync('sessions.stopAll'),
      flushPendingPersists: trackAsync('sessions.flushPendingPersists')
    },
    analytics: { flush: trackAsync('analytics.flush') },
    terminals: {
      list: () => [{ id: 't1' }],
      shutdown: trackAsync('terminals.shutdown')
    },
    search: { close: trackAsync('search.close') },
    intelligenceGateway: { close: trackAsync('intelligenceGateway.close') },
    missionGateway: { close: trackAsync('missionGateway.close') },
    graphScheduler: { close: trackAsync('graphScheduler.close') },
    graphify: { cancel: trackAsync('graphify.cancel') },
    passiveLearning: { close: trackAsync('passiveLearning.close') },
    memoryStore: { close: trackAsync('memoryStore.close') },
    knowledgeUsage: { close: trackAsync('knowledgeUsage.close') },
    registry: { shutdown: trackAsync('registry.shutdown') },
    sharedGitnexus: { stop: track('sharedGitnexus.stop') },
    processes: { close: trackAsync('processes.close') },
    log,
    capMs: 500,
    ...overrides
  };

  return { targets, order, log };
}

describe('runGracefulShutdown', () => {
  it('stops synchronous hooks and remote services before session drain and completes cleanly', async () => {
    const { targets, order, log } = makeTargets();
    const result = await runGracefulShutdown(targets);

    expect(result.timedOut).toBe(false);
    // All synchronous pre-stop hooks (including analyticsSync, remoteHost) run before sessions.stopAll.
    const stopIdx = order.indexOf('sessions.stopAll');
    expect(stopIdx).toBeGreaterThan(0);
    for (const hook of [
      'localControl.shutdown',
      'keepAwake.quit',
      'mission.dispose',
      'updater.stopChecking',
      'analyticsSync.stop',
      'remoteHost.close'
    ]) {
      expect(order.indexOf(hook)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(hook)).toBeLessThan(stopIdx);
    }

    // Session drain ordering: stopAll -> flushPendingPersists -> analytics.flush.
    expect(order.indexOf('sessions.stopAll')).toBeLessThan(order.indexOf('sessions.flushPendingPersists'));
    expect(order.indexOf('sessions.flushPendingPersists')).toBeLessThan(order.indexOf('analytics.flush'));

    // Passive learning closes before the memory ledger closes.
    expect(order.indexOf('passiveLearning.close')).toBeLessThan(order.indexOf('memoryStore.close'));

    // Every parallel subsystem ran.
    for (const label of [
      'terminals.shutdown',
      'search.close',
      'intelligenceGateway.close',
      'missionGateway.close',
      'graphScheduler.close',
      'graphify.cancel',
      'knowledgeUsage.close',
      'registry.shutdown',
      'sharedGitnexus.stop',
      'processes.close'
    ]) {
      expect(order).toContain(label);
    }
    expect(log).toHaveBeenCalledWith('info', 'quitting: 1 live session(s), 1 terminal tab(s)');
    expect(log).toHaveBeenCalledWith('info', expect.stringMatching(/^shutdown complete in \d+ms$/));
  });

  it('isolates synchronous and asynchronous failures so persistence flushes and memoryStore.close still run', async () => {
    const { targets, order, log } = makeTargets();
    targets.remoteHost = {
      close: () => {
        order.push('remoteHost.close');
        throw new Error('socket boom');
      }
    };
    targets.sessions!.stopAll = async () => {
      order.push('sessions.stopAll');
      throw new Error('adapter hang');
    };
    targets.passiveLearning = {
      close: async () => {
        order.push('passiveLearning.close');
        throw new Error('passive boom');
      }
    };
    targets.registry = {
      shutdown: async () => {
        order.push('registry.shutdown');
        throw new Error('vesta boom');
      }
    };

    const result = await runGracefulShutdown(targets);

    expect(result.timedOut).toBe(false);
    expect(order).toContain('sessions.flushPendingPersists');
    expect(order).toContain('analytics.flush');
    expect(order).toContain('memoryStore.close');
    expect(order).toContain('processes.close');
    expect(order.indexOf('passiveLearning.close')).toBeLessThan(order.indexOf('memoryStore.close'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('remote host close during shutdown failed: Error: socket boom'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('session stop during shutdown failed: Error: adapter hang'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('passive learning close during shutdown failed: Error: passive boom'));
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('registry shutdown during shutdown failed: Error: vesta boom'));
  });

  it('returns timedOut when a service hangs past the shutdown cap', async () => {
    const { targets, log } = makeTargets({
      capMs: 40,
      terminals: {
        list: () => [],
        shutdown: () => new Promise<void>(() => undefined)
      }
    });

    const result = await runGracefulShutdown(targets);

    expect(result.timedOut).toBe(true);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('shutdown exceeded the 40ms cap'));
  });

  it('RemoteHost.close tears down without logging a user disconnect or pushing state', () => {
    const pushState = vi.fn();
    const log = vi.fn();
    const host = new RemoteHost({
      secrets: { get: async () => undefined, set: async () => undefined },
      pushState,
      log
    });

    host.close();

    expect(host.state().status).toBe('off');
    expect(log).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
  });
});
