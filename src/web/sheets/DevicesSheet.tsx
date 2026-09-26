/** Device management (P4): every device of the account, revocable from here. */
import { useEffect, useState } from 'react';
import { Button, Spinner } from '@renderer/components/ui';
import type { RelayClient } from '../../../relay/src/web-client';
import type { RemoteDeviceInfo } from '@shared/types';
import { BottomSheet } from './BottomSheet';

/** Revoking this browser's own device ends its pairing; the caller decides what to do after. */
export function DevicesSheet({ client, onClose, onPairingEnded }: {
  client: RelayClient;
  onClose: () => void;
  onPairingEnded: () => void;
}) {
  const [devices, setDevices] = useState<RemoteDeviceInfo[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    client.listDevices()
      .then((list) => { if (alive) setDevices(list); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [client]);

  const revoke = async (deviceId: string) => {
    setError('');
    try {
      const before = client.pairings().length;
      await client.revokeDevice(deviceId);
      // Revoking this browser, or a computer it was paired with, ends those pairings here too.
      if (client.pairings().length < before) {
        onPairingEnded();
        onClose();
        return;
      }
      setDevices(await client.listDevices());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const own = client.credentials()?.webDeviceId;
  return (
    <BottomSheet title="Devices" onClose={onClose}>
      {!devices && !error && <div className="w-loading"><Spinner /> Loading devices…</div>}
      {error && <p className="w-error" role="alert">{error}</p>}
      <ul className="w-list">
        {(devices ?? []).map((device) => (
          <li key={device.deviceId} className="w-list-row">
            <span className="w-list-main">
              <span className="w-list-name">{device.kind === 'host' ? 'Computer' : 'Browser'}: {device.name}{device.deviceId === own ? ' (this browser)' : ''}</span>
              <span className="w-list-hint">{device.platform} · {device.online ? 'online now' : `last seen ${new Date(device.lastSeen).toLocaleString()}`}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => void revoke(device.deviceId)}>Revoke</Button>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}
