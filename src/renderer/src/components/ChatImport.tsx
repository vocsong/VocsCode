/** Explicit, desktop-only discovery and text import of existing coding-agent conversations. */
import React, { useState } from 'react';
import { CHAT_IMPORT_SKIP_REASON_LABELS, type ChatImportCandidate, type ChatImportSkipCounts, type ChatImportSkipReason, type ChatImportSource } from '../../../shared/chat-import';
import { invoke, invokeErrorMessage, isWeb } from '../api';
import { useStore } from '../store';
import { Badge, Button, Icon, Spinner } from './ui';

const SOURCE_NAMES: Record<ChatImportSource, string> = { claude: 'Claude Code', codex: 'Codex' };
const MAX_SELECTION = 200;

export function ChatImport() {
  const toast = useStore((s) => s.toast);
  const [source, setSource] = useState<ChatImportSource | null>(null);
  const [candidates, setCandidates] = useState<ChatImportCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<'scan' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [skippedReasons, setSkippedReasons] = useState<ChatImportSkipCounts>({});
  const [scanErrors, setScanErrors] = useState(0);
  const [malformedLines, setMalformedLines] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const scan = async (next: ChatImportSource) => {
    setBusy('scan');
    setSource(next);
    setCandidates([]);
    setSelected([]);
    setSkipped(0);
    setSkippedReasons({});
    setScanErrors(0);
    setMalformedLines(0);
    setTruncated(false);
    setError(null);
    try {
      const result = await invoke('sessions:importList', { source: next });
      setCandidates(result.candidates);
      setSkipped(result.skipped);
      setSkippedReasons(result.skippedReasons ?? {});
      setScanErrors(result.scanErrors ?? 0);
      setMalformedLines(result.malformedLines ?? 0);
      setTruncated(result.truncated ?? false);
    } catch (e) {
      setError(invokeErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const importSelected = async () => {
    if (!source || !selected.length || busy) return;
    setBusy('import');
    setError(null);
    try {
      const result = await invoke('sessions:import', { source, ids: selected });
      setSelected([]);
      const count = result.imported.length;
      toast(`${count} ${count === 1 ? 'chat imported' : 'chats imported'}${result.skipped ? `; ${result.skipped} skipped` : ''}`, count ? 'success' : 'info');
      // Import is also an explicit request to refresh its preview: deduplication may have rejected
      // a chat imported in another window since the scan, so use the authoritative list again.
      try {
        const refreshed = await invoke('sessions:importList', { source });
        setCandidates(refreshed.candidates);
        setSkipped(refreshed.skipped);
        setSkippedReasons(refreshed.skippedReasons ?? {});
        setScanErrors(refreshed.scanErrors ?? 0);
        setMalformedLines(refreshed.malformedLines ?? 0);
        setTruncated(refreshed.truncated ?? false);
      } catch (e) {
        setError(`Import finished, but the list could not refresh: ${invokeErrorMessage(e)}. Scan again to refresh it.`);
      }
    } catch (e) {
      const message = invokeErrorMessage(e);
      setError(message);
      toast(message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const available = candidates.filter((candidate) => !candidate.imported);
  const skipRows = Object.entries(CHAT_IMPORT_SKIP_REASON_LABELS).flatMap(([reason, label]) => {
    const count = skippedReasons[reason as ChatImportSkipReason] ?? 0;
    return count > 0 ? [{ reason, label, count }] : [];
  });

  return (
    <div className="settings-section">
      <h2>Import chats</h2>
      <p className="muted">Bring existing Claude Code or Codex conversations into Vocs Code. Choose a source to scan its local chat history, then select the chats to import.</p>
      <p className="muted small">Only user and assistant text is copied. Tool activity, images, settings and credentials are excluded. Continuing an imported chat starts a new session with the conversation as context.</p>
      {isWeb ? <p className="muted">Chat import is available in the desktop app.</p> : <>
        <div className="row gap8">
          {(['claude', 'codex'] as const).map((option) => <Button key={option} disabled={busy !== null} onClick={() => void scan(option)}>
            {busy === 'scan' && source === option ? <Spinner size={12} /> : <Icon name="search" size={12} />}
            Scan {SOURCE_NAMES[option]}
          </Button>)}
        </div>
        {error && <p role="alert" className="info-line info-error">{error}</p>}
        {source && busy !== 'scan' && !error && candidates.length === 0 && <p role="status" className="muted">No importable {SOURCE_NAMES[source]} chats found.</p>}
        {skipped > 0 && <>
          <p className="muted small">{skipped} history {skipped === 1 ? 'file' : 'files'} skipped.</p>
          {skipRows.length > 0 && <ul aria-label="Skipped chat reasons" className="muted small">
            {skipRows.map(({ reason, label, count }) => <li key={reason}>{count} — {label}</li>)}
          </ul>}
        </>}
        {scanErrors > 0 && <p role="status" className="muted small">{scanErrors} history {scanErrors === 1 ? 'directory' : 'directories'} could not be scanned. Some chats may be missing.</p>}
        {malformedLines > 0 && <p className="muted small">{malformedLines} malformed {malformedLines === 1 ? 'history entry was' : 'history entries were'} ignored.</p>}
        {truncated && <p role="status" className="muted small">The scan reached its safety limit. Some chats may be missing from this list.</p>}
        {candidates.length > 0 && <>
          {available.length > MAX_SELECTION && <p className="muted small">Import up to {MAX_SELECTION} chats at a time. Import a batch, then select more from the refreshed list.</p>}
          <div className="row gap8" style={{ marginTop: 16, marginBottom: 12 }}>
            <Button size="sm" variant="ghost" disabled={busy !== null || !available.length} onClick={() => setSelected(selected.length === Math.min(available.length, MAX_SELECTION) ? [] : available.slice(0, MAX_SELECTION).map((candidate) => candidate.id))}>
              {selected.length === Math.min(available.length, MAX_SELECTION) && available.length ? 'Clear selection' : available.length > MAX_SELECTION ? `Select first ${MAX_SELECTION}` : 'Select all'}
            </Button>
            <Button variant="primary" disabled={busy !== null || !selected.length} onClick={() => void importSelected()}>
              {busy === 'import' && <Spinner size={12} />}
              Import selected{selected.length ? ` (${selected.length})` : ''}
            </Button>
          </div>
          <div aria-label={`${SOURCE_NAMES[source!]} chats`} aria-busy={busy !== null}>
            {candidates.map((candidate) => <label key={candidate.id} className="provider-card provider-head">
              <input type="checkbox" style={{ width: 16, height: 16, padding: 0, flex: '0 0 auto' }} aria-label={`Import ${candidate.title}`} checked={selected.includes(candidate.id)} disabled={busy !== null || candidate.imported || selected.length >= MAX_SELECTION && !selected.includes(candidate.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, candidate.id].slice(0, MAX_SELECTION) : current.filter((id) => id !== candidate.id))} />
              <span className="spacer" style={{ minWidth: 0 }}>
                <strong>{candidate.title}</strong>
                <span className="muted small" style={{ display: 'block', overflowWrap: 'anywhere' }}>{candidate.projectRoot}</span>
                <span className="muted small">{candidate.messageCount} messages · {new Date(candidate.updatedAt).toLocaleDateString()}</span>
              </span>
              {candidate.imported && <Badge tone="green">Imported</Badge>}
            </label>)}
          </div>
        </>}
      </>}
    </div>
  );
}
