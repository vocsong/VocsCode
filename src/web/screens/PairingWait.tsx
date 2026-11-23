/** Waiting for the desktop's Allow. The cancel is local: the claim stays alive at the relay, so
 *  an approval that arrives after a cancel still lands, and the shell enters the app. */
import { Button } from '@renderer/components/ui';

export function PairingWait({ onCancel }: { onCancel: () => void }) {
  return (
    <section className="w-screen" data-testid="pairing-wait">
      <div className="w-screen-inner">
        <div className="w-screen-brand"><span className="w-brand">Vocs Code</span></div>
        <div className="w-card w-wait" role="status" aria-live="polite">
          <div className="w-wait-ring" aria-hidden />
          <h1>Waiting for approval…</h1>
          <p className="w-lead">On your computer, click <strong>Allow</strong> in Vocs Code (Settings → Remote access). The request expires in five minutes.</p>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </section>
  );
}
