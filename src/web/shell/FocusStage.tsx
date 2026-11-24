import type { ReactNode } from 'react';

/** The Vocs UI focus layout used for sign-in and device linking. The app itself has no aura. */
export function FocusStage({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <section className="v-stage w-focus-stage" aria-labelledby="focus-title" data-testid={testId}>
      <div className="v-aura v-aura-soft" aria-hidden="true"><i /><i /><i /></div>
      <div className="v-stage-col">
        <div className="v-card v-panel-card w-focus-card">{children}</div>
      </div>
    </section>
  );
}
