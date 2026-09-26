/** Subscribes to the transport's connection state machine. */
import { useEffect, useState } from 'react';
import type { ConnectionState, RelayTransport } from '../transport/relay-transport';

export function useConnection(transport: RelayTransport): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() => transport.state());
  useEffect(() => transport.onState(() => setState(transport.state())), [transport]);
  return state;
}
