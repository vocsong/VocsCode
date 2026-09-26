/** New session from the phone: folder, harness and first prompt, then sessions:create. */
import { useEffect, useState } from 'react';
import { invoke } from '@renderer/api';
import { Button, Field, Spinner } from '@renderer/components/ui';
import type { HarnessId, SessionConfig } from '@shared/types';
import { BottomSheet } from './BottomSheet';

export function NewSessionSheet({ onClose, onCreated, defaultRoot }: {
  onClose: () => void;
  onCreated: (id: string) => void;
  defaultRoot?: string;
}) {
  const [folders, setFolders] = useState<string[]>([]);
  const [harnesses, setHarnesses] = useState<Array<{ id: string; available: boolean }>>([]);
  const [folder, setFolder] = useState(defaultRoot ?? '');
  const [harness, setHarness] = useState<HarnessId>('claude');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const settings = await invoke('settings:get', undefined);
        if (!alive) return;
        const known = [...new Set([...(settings.folders ?? []), ...(settings.recentProjects ?? [])])];
        setFolders(known);
        setFolder((current) => current || known[0] || '');
      } catch {
        // Settings are optional here; a typed path still works.
      }
      try {
        const availability = await invoke('harness:availability', undefined);
        if (!alive) return;
        setHarnesses(Object.entries(availability).map(([id, state]) => ({ id, available: state?.available === true })));
      } catch {
        // An older desktop without the channel: offer the common harnesses.
      }
    })();
    return () => { alive = false; };
  }, []);

  const create = async () => {
    if (!folder.trim()) {
      setError('A folder path on the computer is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const config: SessionConfig = { harness, projectRoot: folder.trim(), permissionMode: 'ask' };
      const created = await invoke('sessions:create', { config, title: title.trim() || undefined, initialPrompt: prompt.trim() || undefined });
      onCreated(created.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet title="New session" onClose={onClose}>
      <Field label="Folder on the computer">
        <input list="w-folders" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/home/you/project" aria-label="Folder on the computer" />
      </Field>
      <datalist id="w-folders">
        {folders.map((f) => <option key={f} value={f} />)}
      </datalist>
      <Field label="Harness">
        <select value={harness} onChange={(e) => setHarness(e.target.value as HarnessId)} aria-label="Harness">
          {(harnesses.length ? harnesses : [{ id: 'claude', available: true }, { id: 'codex', available: true }, { id: 'pi', available: true }, { id: 'native', available: true }]).map((h) => (
            <option key={h.id} value={h.id}>{h.id}{h.available ? '' : ' (not installed)'}</option>
          ))}
        </select>
      </Field>
      <Field label="Title (optional)">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix the login flow" aria-label="Title" />
      </Field>
      <Field label="First prompt (optional)">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} aria-label="First prompt" />
      </Field>
      {error && <p className="w-error" role="alert">{error}</p>}
      <Button variant="primary" disabled={busy} onClick={() => void create()}>{busy ? <Spinner size={13} /> : 'Start session'}</Button>
    </BottomSheet>
  );
}
