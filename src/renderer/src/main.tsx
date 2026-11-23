/** Renderer entry point: mounts the React tree. */
import React from 'react';
import { createRoot } from 'react-dom/client';
// Base stylesheet first so @layer ordering precedes every component-local feature sheet.
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { startDiagnostics } from './diag';
import { installThemeStyles } from './theme';
// The minimalist Zen interface, keyed on <html data-ui> in @layer modes.
import './ui-zen.css';

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
