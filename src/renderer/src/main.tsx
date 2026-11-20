/** Renderer entry point: mounts the React tree. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { startDiagnostics } from './diag';
import { installThemeStyles } from './theme';
import './styles.css';
// The minimalist interface modes, keyed on <html data-ui>; after styles.css so they win ties.
import './ui-zen.css';
import './ui-paper.css';

// Before the first render, so a non-default theme never paints with the fallback palette.
installThemeStyles();
// Records renderer stalls in the main log, so a window that stops taking input says why.
startDiagnostics();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
