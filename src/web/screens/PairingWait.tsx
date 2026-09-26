/** Waiting for the desktop's Allow. The cancel is local: the claim stays alive at the relay, so
 *  an approval that arrives after a cancel still lands, and the shell enters the app. */
import { Button } from '@renderer/components/ui';

export function PairingWait({ onCancel }: { onCancel: () => void }) {
  return (
    <section className="w-screen" data-testid="pairing-wait">
      <div className="w-card">
        <h1>Waiting for approval…</h1>
        <p className="w-hint">Click Allow in Vocs Code on your computer (Settings → Remote access). The request expires in five minutes.</p>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  );
}
