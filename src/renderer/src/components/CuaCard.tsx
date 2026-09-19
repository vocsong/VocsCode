/**
 * Computer use (Cua Driver) settings, shown on the global MCP page and on a session's MCP tab.
 *
 * This is the one place the opt-in and the authorization profile are chosen. The driver itself is
 * installed by the user, never by the app; the card only reports what was found and asks for the
 * mode the runtime should start in.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CUA_PERMISSION_MODES, type CuaPermissionMode, type CuaSettings, type CuaStatus } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { askConfirm, Badge, Button, Icon, Toggle } from './ui';

const MODE_LABEL: Record<CuaPermissionMode, string> = {
  standard: 'Standard — Vocs Code prompts for each call',
  bounded: 'Bounded — scoped by a capability manifest',
  unrestricted: 'Unrestricted — bypasses Cua approvals'
};

export function CuaCard({ compact = false, repo }: { compact?: boolean; repo?: { enabled: boolean; disabled: boolean; onChange: (on: boolean) => void } }) {
  const settings = useStore((s) => s.settings);
  const toast = useStore((s) => s.toast);
  const cua: CuaSettings = settings?.cua ?? { enabled: false, mode: 'standard' };
  const [status, setStatus] = useState<CuaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [manifestDraft, setManifestDraft] = useState(cua.manifestPath ?? '');

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke('cua:status', undefined));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, cua.enabled, cua.mode, cua.manifestPath]);

  useEffect(() => {
    setManifestDraft(cua.manifestPath ?? '');
  }, [cua.manifestPath]);

  const patch = async (next: Partial<CuaSettings>) => {
    setBusy(true);
    try {
      await invoke('settings:update', { cua: { ...cua, ...next } });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (on: boolean) => {
    if (on && cua.mode === 'unrestricted') {
      const ok = await askConfirm({
        title: 'Turn on unrestricted computer use?',
        body: <>The agent may perform any action on this machine without Cua Driver asking, including anything your desktop can reach. Use it only in a disposable environment.</>,
        confirmLabel: 'Turn on',
        danger: true
      });
      if (!ok) return;
    }
    await patch({ enabled: on });
  };

  const setMode = async (mode: CuaPermissionMode) => {
    if (mode === 'unrestricted') {
      const ok = await askConfirm({
        title: 'Switch to unrestricted mode?',
        body: <>Cua Driver stops asking before each desktop action. Vocs Code still prompts per tool call below Full access, but nothing inside the driver is gated.</>,
        confirmLabel: 'Use unrestricted',
        danger: true
      });
      if (!ok) return;
    }
    await patch({ mode });
  };

  const saveManifest = async () => {
    const manifestPath = manifestDraft.trim();
    await patch({ manifestPath: manifestPath || undefined });
    toast(manifestPath ? 'Manifest path saved' : 'Manifest path cleared', 'success');
  };

  // The built-in's Test connection: a real MCP handshake, so an install that cannot actually
  // serve its tools is caught here rather than inside the first session that needs it.
  const runTest = async () => {
    setTesting(true);
    try {
      const r = await invoke('cua:test', undefined);
      if (r.ok) toast(`Cua Driver answered with ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}`, 'success');
      else toast(r.error ?? 'Cua Driver did not answer', 'error');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setTesting(false);
    }
  };

  const installed = status?.installed === true;

  return (
    <div className="mcp-card" data-testid="cua-card">
      <div className="mcp-row-head">
        <Toggle checked={cua.enabled} disabled={busy || !installed} onChange={(v) => void setEnabled(v)} label="Enable computer use" />
        <Icon name="cpu" size={12} />
        <span className="mcp-name">Cua Driver</span>
        <Badge tone="blue">built-in</Badge>
        <span className="spacer" />
        {installed ? <Badge tone="green">{status?.version ?? 'installed'}</Badge> : <Badge tone="amber">not installed</Badge>}
        {cua.mode === 'unrestricted' && <Badge tone="red">unrestricted</Badge>}
      </div>
      <div className="muted small">
        {compact
          ? 'Computer use is managed on the MCP page. Off by default; an agent that uses it can operate apps and browsers on this machine.'
          : 'Let agents drive native apps and browsers on this machine. Off by default, and Vocs Code still prompts for each tool call below Full access.'}
      </div>
      {!installed && (
        <div className="mcp-index-row">
          <span className="muted small mono">
            macOS/Linux: curl -fsSL https://cua.ai/driver/install.sh | bash · Windows: irm https://cua.ai/driver/install.ps1 | iex
          </span>
          <Button size="sm" icon="refresh" disabled={busy} onClick={() => void refresh()}>
            Re-check
          </Button>
        </div>
      )}
      {installed && !compact && (
        <>
          <div className="mcp-control-list">
            <label className="muted small">
              Authorization mode
              <select value={cua.mode} disabled={busy} onChange={(e) => void setMode(e.target.value as CuaPermissionMode)}>
                {CUA_PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {cua.mode === 'bounded' && (
            <div className="mcp-index-row">
              <input
                className="mono"
                placeholder="Path to cua-capabilities.yaml"
                value={manifestDraft}
                disabled={busy}
                onChange={(e) => setManifestDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveManifest();
                }}
              />
              <Button size="sm" icon="check" disabled={busy} onClick={() => void saveManifest()}>
                Save
              </Button>
            </div>
          )}
          <div className="muted small" data-testid="cua-note">
            {status?.note}
          </div>
          {status?.modeSource === 'host' && (
            <div className="muted small">The mode is granted by Cua Driver's own app daemon on this platform; change it there.</div>
          )}
          <div className="mcp-index-row">
            <span className="muted small">{status?.path ?? ''}</span>
            <Button size="sm" icon="cpu" disabled={testing || busy} data-testid="cua-test" onClick={() => void runTest()}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>
        </>
      )}
      {installed && compact && <div className="muted small" data-testid="cua-note">{status?.note}</div>}
      {compact && repo && (
        <div className="mcp-control-list">
          <Toggle checked={repo.enabled} disabled={busy || repo.disabled} onChange={repo.onChange} label="Enable computer use for this repo" />
        </div>
      )}
    </div>
  );
}