/** Renderer entry point: mounts the React tree. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installThemeStyles } from './theme';
import './styles.css';

// Before the first render, so a non-default theme never paints with the fallback palette.
installThemeStyles();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
