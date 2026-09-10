/**
 * Terminal types and pure helpers shared by main and renderer: shell kinds, per-tab metadata, the
 * OSC working-directory parser and the flow-control thresholds. No Node/Electron/DOM imports.
 */

export type ShellKind = 'auto' | 'pwsh' | 'powershell' | 'cmd' | 'gitbash' | 'wsl' | 'bash' | 'zsh' | 'fish' | 'sh' | 'custom';

export interface ShellOption {
  kind: ShellKind;
  name: string;
  /** Absolute path of the executable. */
  path: string;
}

export interface TerminalSettings {
  /** Default shell for new terminals; 'auto' follows the platform convention (PowerShell, or $SHELL). */
  shell: ShellKind;
  /** Executable and arguments used when `shell` is 'custom'. */
  customShellPath: string;
  customShellArgs: string[];
  fontSize: number;
  /** Lines kept above the visible screen, per terminal, in both the renderer and the main-process mirror. */
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  /** Save every terminal's screen on quit and bring the tabs back on the next launch. */
  restoreOnStartup: boolean;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  shell: 'auto',
  customShellPath: '',
  customShellArgs: [],
  fontSize: 13,
  scrollback: 10_000,
  cursorStyle: 'block',
  cursorBlink: true,
  restoreOnStartup: true
};

export interface TerminalInfo {
  id: string;
  sessionId: string;
  /** Tab label: the title the shell sets (OSC 0/2), a user rename, or the shell name. */
  title: string;
  /** True once the user renamed the tab; shell titles no longer replace it. */
  customTitle?: boolean;
  shell: ShellKind;
  shellName: string;
  /** Working directory the shell reports (OSC 7 / OSC 9;9), else the directory it started in. */
  cwd: string;
  pid?: number;
  createdAt: number;
  /** Set when the shell exited; the tab stays readable until it is closed or restarted. */
  exit?: { code: number; signal?: number };
  /** Brought back from the previous run; a shell is spawned the first time the tab is shown. */
  restored?: boolean;
}

/** Characters pushed to the renderer but not yet acknowledged: pause the PTY above HIGH, resume below LOW. */
export const FLOW_HIGH_WATER = 256 * 1024;
export const FLOW_LOW_WATER = 64 * 1024;

/**
 * Working directory announced by a shell through OSC 7 (`file://host/path`) or ConPTY / Windows
 * Terminal's OSC 9;9 (`9;C:\path`). Anything else yields undefined.
 */
export function parseOscCwd(ident: number, data: string, platform: string): string | undefined {
  if (ident === 7) {
    const m = /^file:\/\/([^/]*)(\/.*)$/.exec(data.trim());
    if (!m) return undefined;
    let p = safeDecode(m[2]);
    if (platform === 'win32') {
      // file:///C:/Users/x -> C:\Users\x
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      p = p.replace(/\//g, '\\');
    }
    return p || undefined;
  }
  if (ident === 9) {
    const m = /^9;([^]*)$/.exec(data);
    const p = m?.[1].trim();
    return p || undefined;
  }
  return undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The tab label for a title the shell announced (OSC 0/2). cmd.exe and Windows PowerShell set their
 * own executable path at startup and `<exe> - <command>` while something runs; the path is noise,
 * the command is the label. Anything else is shown as-is; an empty title falls back.
 */
export function cleanTitle(raw: string, shellFile: string, fallback: string): string {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return fallback;
  const norm = (s: string) => s.replace(/\//g, '\\').toLowerCase();
  const exe = norm(shellFile);
  const exeBase = exe.split('\\').pop() ?? exe;
  const isShell = (s: string) => !!exe && (norm(s) === exe || norm(s) === exeBase);
  if (isShell(title)) return fallback;
  const m = /^(.+?) - (.+)$/.exec(title);
  if (m && isShell(m[1])) return m[2].trim() || fallback;
  return title;
}

/** Last path segment (`repo` for `C:\dev\repo`), used for labels when the shell sets no title. */
export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
