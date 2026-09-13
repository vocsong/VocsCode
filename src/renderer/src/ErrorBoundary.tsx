/**
 * Last line of defence for the renderer. React unmounts the whole tree when a render throws, which
 * leaves the window blank; this keeps a themed message and a reload button on screen and puts the
 * exception in the main log. Global (non-render) errors are reported by diag.ts instead.
 */
import React from 'react';
import { invoke } from './api';
import { reportRendererError } from './diag';
import { Button, Icon } from './components/ui';
import { TitleBar } from './components/TitleBar';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportRendererError(error.message, error.stack, info.componentStack ?? undefined);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="shell">
        <TitleBar />
        <div className="boot boot-error" role="alert">
          <div className="boot-error-copy">
            <Icon name="alert" size={24} />
            <strong>The interface hit an error</strong>
            <span className="boot-error-detail">{error.message}</span>
          </div>
          <Button variant="primary" icon="refresh" onClick={() => void invoke('window:reload', undefined)}>
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
