/**
 * The Desktop tab: a read-only, live preview of the screen a computer-use agent is acting on,
 * with the session's interrupt as the stop control. Acting is the agent's job through the injected
 * Cua Driver server; this tab only observes (get_desktop_state never moves the pointer or takes
 * focus) so the user can see what is happening without watching the desktop itself.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { CuaPreviewResult, CuaStatus, SessionMeta } from '../../../shared/types';
import { invoke } from '../api';
import { useStore } from '../store';
import { CuaCard } from './CuaCard';
import { Button, Spinner } from './ui';

const POLL_MS = 2_000;

export function DesktopTab({ session }: { session: SessionMeta }) {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<CuaStatus | null>(null);
  const [preview, setPreview] = useState<CuaPreviewResult | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await invoke('cua:status', undefined));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const ready = status?.installed === true && status.ready;

  useEffect(() => {
    if (!ready) return;
    let live = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await invoke('cua:preview', undefined);
        if (live) setPreview(result);
      } catch (e) {
        if (live) setPreview({ ok: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ready]);

  const interrupt = async () => {
    setBusy(true);
    try {
      await invoke('sessions:interrupt', { id: session.id });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="mcp-loading">
        <Spinner size={14} /> Checking Cua Driver…
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="mcp-tab">
        <CuaCard compact />
      </div>
    );
  }

  return (
    <div className="desktop-tab" data-testid="desktop-tab">
      <div className="changes-head">
        <span className="muted small">Live screen · {status.mode}</span>
        <span className="spacer" />
        <Button size="sm" variant="danger" icon="stop" disabled={busy} onClick={() => void interrupt()} title="Interrupt the current turn">
          Stop
        </Button>
      </div>
      <div className="desktop-frame">
        {preview?.ok && preview.imageDataUrl ? (
          <img src={preview.imageDataUrl} alt="Live desktop" data-testid="desktop-frame-image" />
        ) : (
          <div className="muted small pad" data-testid="desktop-frame-empty">
            {preview?.error ?? 'Waiting for the first capture…'}
          </div>
        )}
      </div>
      <div className="muted small pad">
        Read-only preview of what the agent sees. Acting on the desktop is the agent's job; Stop interrupts the current turn.
      </div>
    </div>
  );
}