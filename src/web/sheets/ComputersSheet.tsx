/** The computer switcher: every pairing this browser holds, with the active one marked. */
import { useState } from 'react';
import { Button } from '@renderer/components/ui';
import type { RelayClient } from '../../../relay/src/web-client';
import { BottomSheet } from './BottomSheet';

export function ComputersSheet({ client, online, onClose, onAdd, onSwitched }: {
  client: RelayClient;
  online: Map<string, boolean>;
  onClose: () => void;
  onAdd: () => void;
  onSwitched: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const active = client.credentials();
  return (
    <BottomSheet title="Computers" onClose={onClose}>
      <ul className="w-list">
        {client.pairings().map((pairing) => {
          const current = pairing === active;
          const presence = online.get(pairing.hostDeviceId);
          return (
            <li key={pairing.hostDeviceId} className={`w-list-row ${current ? 'is-active' : ''}`}>
              <button
                type="button"
                className="w-list-main"
                disabled={busy !== null || current}
                onClick={() => {
                  setBusy(pairing.hostDeviceId);
                  void client.select(pairing.hostDeviceId).then(() => {
                    setBusy(null);
                    onSwitched();
                    onClose();
                  }).catch(() => setBusy(null));
                }}
              >
                <span className="w-list-name">{pairing.hostName ?? 'Computer'}</span>
                <span className="w-list-hint">{presence === undefined ? '…' : presence ? 'online' : 'offline'}{current ? ' · current' : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <Button variant="ghost" icon="plus" onClick={onAdd}>Add a computer</Button>
    </BottomSheet>
  );
}
