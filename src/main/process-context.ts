/**
 * Who a child process is started for. A session runs every adapter call inside its owner context,
 * and Node's `child_process` diagnostics channel reports each ChildProcess as it is created — in
 * the creating call's async context — so a harness CLI that an SDK spawns on its own is still
 * attributed to the session, without any adapter knowing about the Processes panel.
 *
 * PTY shells are not ChildProcesses; the tracker reads those from the terminal manager instead.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { ProcessOwner } from '../shared/processes';

const owners = new AsyncLocalStorage<ProcessOwner>();

/** Runs `fn` so that every process it starts, now or from its async continuations, is `owner`'s. */
export function withProcessOwner<T>(owner: ProcessOwner, fn: () => T): T {
  return owners.run(owner, fn);
}

export function currentProcessOwner(): ProcessOwner | undefined {
  return owners.getStore();
}

/**
 * The adapter with each method call run as `owner`. Methods are applied to the real adapter, so
 * private fields keep working, and each wrapper is created once so identity checks still hold.
 */
export function ownedAdapter<T extends object>(adapter: T, owner: ProcessOwner): T {
  const wrappers = new WeakMap<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>();
  return new Proxy(adapter, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      const method = value as (...args: unknown[]) => unknown;
      let wrapped = wrappers.get(method);
      if (!wrapped) {
        wrapped = (...args: unknown[]) => owners.run(owner, () => method.apply(target, args));
        wrappers.set(method, wrapped);
      }
      return wrapped;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    }
  });
}

/**
 * Reports the PID of every ChildProcess started inside an owner context. The channel publishes as
 * the ChildProcess is constructed, before it has a PID, so the report waits for its `spawn` event;
 * a spawn that fails is never reported.
 */
export function observeOwnedSpawns(report: (pid: number, owner: ProcessOwner) => void): () => void {
  const listener = (message: unknown) => {
    const owner = owners.getStore();
    const child = (message as { process?: ChildProcess } | null)?.process;
    if (!owner || !child || typeof child.once !== 'function') return;
    if (child.pid) report(child.pid, owner);
    else child.once('spawn', () => {
      if (child.pid) report(child.pid, owner);
    });
  };
  subscribe('child_process', listener);
  return () => {
    unsubscribe('child_process', listener);
  };
}
