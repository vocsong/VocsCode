/** Shared presentational primitives: icons, buttons, badges, dropdowns, modals and toggles. */
import React, { useEffect, useRef, useState } from 'react';

const ICONS: Record<string, string> = {
  logo: 'M6.4 7.2L12 17L17.6 7.2M9.2 19h5.6',
  plus: 'M12 5v14M5 12h14',
  dollar: 'M12 2v20M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1L15 3H9l-.3 2.6a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2l-2 1.5 2 3.4 2.3-1c.5.4 1.1.7 1.7 1L9 21h6l.3-2.6c.6-.3 1.2-.6 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  diff: 'M7 3v8M3 7h8M3 17h8M13 3l8 18',
  stop: 'M6 6h12v12H6z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  chevron: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  pin: 'M12 17v5M5 17h14l-2-5V4H7v8l-2 5z',
  archive: 'M3 3h18v5H3zM5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4',
  restore: 'M3 12a9 9 0 1 0 3-6.7M3 3v6h6M12 7v5l3 3',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  external: 'M14 4h6v6M20 4l-9 9M19 14v6H4V5h6',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6zM14 3v6h6',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 6-12 3-12 9',
  pr: 'M6 9v9M6 15a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM18 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 15v2a3 3 0 0 1-3 3H9m0 0 3-3m-3 3 3 3',
  image: 'M4 5h16v14H4zM8 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-5-5-9 9',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-5a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  play: 'M6 4l14 8-14 8z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  brain: 'M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z',
  shield: 'M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z',
  fork: 'M7 3v6a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4V3M12 13v8',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.1A11 11 0 0 1 12 5c7 0 11 7 11 7a18 18 0 0 1-3.2 4M6.6 6.6A18 18 0 0 0 1 12s4 7 11 7a11 11 0 0 0 4.1-.8',
  layout: 'M3 5h18v14H3zM15 5v14',
  sidebar: 'M3 5h18v14H3zM9 5v14',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  compact: 'M4 14h16M4 10h16M12 3l3 3-3 3M12 21l3-3-3-3',
  download: 'M12 3v12M6 11l6 6 6-6M4 21h16',
  star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.2-5.9 3.2 1.2-6.5L2.5 9.4l6.6-.9z',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6M14 4l-4 16',
  bug: 'M12 8a4 4 0 0 1 4 4v3a4 4 0 0 1-8 0v-3a4 4 0 0 1 4-4zM9 5l-2-2M15 5l2-2M4 13h4M16 13h4M5 9l3 2M19 9l-3 2M5 18l3-2M19 18l-3-2M12 8v10',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  rocket: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  cpu: 'M6 6h12v12H6zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M9.5 9.5h5v5h-5z',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM21 5v14c0 1.66-4.03 3-9 3s-9-1.34-9-3V5M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  fire: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z',
  cube: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v9',
  layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  box: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  flag: 'M4 22V4M4 4s1-1 5-1 5 2 8 2 4-1 4-1v10s-1 1-4 1-5-2-8-2-5 1-5 1',
  bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  map: 'M9 4l6 2 6-2v14l-6 2-6-2-6 2V6l6-2zM9 4v14M15 6v14',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  palette: 'M12 22a10 10 0 1 1 10-10c0 1.7-1.3 3-3 3h-2.3c-1 0-1.7.8-1.7 1.7 0 .5.2.9.5 1.3.4.4.5.9.5 1.3 0 1.5-1.3 2.7-4 2.7zM7.5 10.5h.01M12 7h.01M16.5 10.5h.01M8 16h.01',
  puzzle: 'M14 4a2 2 0 1 0-4 0v1H7a1 1 0 0 0-1 1v3H5a2 2 0 1 0 0 4h1v3a1 1 0 0 0 1 1h3v1a2 2 0 1 0 4 0v-1h3a1 1 0 0 0 1-1v-3h1a2 2 0 1 0 0-4h-1V6a1 1 0 0 0-1-1h-3V4z',
  robot: 'M8 3h8M12 3v3M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 13h.01M15 13h.01M9 17h6',
  server: 'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01',
  tag: 'M20.59 13.41L12 22 2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  home: 'M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V10z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  coffee: 'M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8zM6 1v3M10 1v3M14 1v3',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2v11zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  video: 'M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z',
  gamepad: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M17.32 5H6.68a4 4 0 0 0-3.98 3.59c-.01 0 0 .01 0 .01L2 18a3 3 0 0 0 5.16 2.06L9.5 17h5l2.34 3.06A3 3 0 0 0 22 18l-.7-9.4A4 4 0 0 0 17.32 5z',
  leaf: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10zM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM16.24 7.76l-2.12 6.53-6.53 2.12 2.12-6.53 6.53-2.12z',
  gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z'
};

export function Icon({ name, size = 16, className, title }: { name: keyof typeof ICONS | string; size?: number; className?: string; title?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path d={ICONS[name] ?? ICONS.info} />
    </svg>
  );
}

export function Button({
  children,
  variant = 'default',
  size = 'md',
  icon,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md'; icon?: string }) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className ?? ''}`} type="button" {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple'; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Dropdown({
  trigger,
  children,
  align = 'left',
  width
}: {
  trigger: (open: boolean) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: 'left' | 'right';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open && (
        <div className={`dropdown-menu dropdown-${align}`} style={width ? { width } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, danger, hint, disabled }: { children: React.ReactNode; onClick?: () => void; active?: boolean; danger?: boolean; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" className={`menu-item ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="menu-item-label">{children}</span>
      {hint && <span className="menu-item-hint">{hint}</span>}
      {active && <Icon name="check" size={14} />}
    </button>
  );
}

export function Modal({ title, onClose, children, width = 720, footer }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; width?: number; footer?: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width, maxWidth: '96vw' }} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirming button as destructive. */
  danger?: boolean;
}

type PendingConfirm = ConfirmOptions & { resolve: (ok: boolean) => void };

let confirmHost: ((p: PendingConfirm | null) => void) | null = null;
let confirmOpen = false;

/**
 * Replaces window.confirm, which must never be used here: Electron answers it with a native message
 * box that disables the whole window until it is dismissed, so a dialog the user does not notice
 * looks exactly like a frozen app — no clicks, no typing, no dropdowns.
 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  if (!confirmHost || confirmOpen) return Promise.resolve(false);
  confirmOpen = true;
  return new Promise<boolean>((resolve) => {
    confirmHost?.({
      ...options,
      resolve: (ok) => {
        confirmOpen = false;
        resolve(ok);
      }
    });
  });
}

/** Mounted once by App; renders whatever askConfirm is currently waiting on. */
export function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  useEffect(() => {
    confirmHost = setPending;
    return () => {
      confirmHost = null;
    };
  }, []);
  if (!pending) return null;
  const answer = (ok: boolean) => {
    setPending(null);
    pending.resolve(ok);
  };
  return (
    <Modal
      title={pending.title}
      width={460}
      onClose={() => answer(false)}
      footer={
        <>
          <span className="spacer" />
          <Button size="sm" onClick={() => answer(false)}>
            {pending.cancelLabel ?? 'Cancel'}
          </Button>
          <Button size="sm" variant={pending.danger ? 'danger' : 'primary'} autoFocus onClick={() => answer(true)}>
            {pending.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {pending.body ?? null}
    </Modal>
  );
}

export function Field({ label, hint, children, inline }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; inline?: boolean }) {
  return (
    <label className={`field ${inline ? 'field-inline' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot status-${status}`} title={status} />;
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  starting: 'Starting',
  running: 'Working',
  awaiting: 'Pending',
  pr: 'PR',
  merged: 'Merged',
  error: 'Error',
  stopped: 'Stopped',
};

export function StatusLabel({ status }: { status: string }) {
  return (
    <span className={`session-status status-${status}`} title={status}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={36} className="empty-icon" />
      <div className="empty-title">{title}</div>
      <div className="empty-body">{children}</div>
    </div>
  );
}
