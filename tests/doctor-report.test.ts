/** `/doctor` reports the About & doctor rows as text and says what to fix — see src/shared/doctor.ts. */
import { describe, expect, it } from 'vitest';
import { formatDoctorReport } from '../src/shared/doctor';
import type { DoctorReport, HarnessAvailability } from '../src/shared/types';

const app = { version: '0.9.3', isPackaged: true };

const report = (harnesses: Record<string, HarnessAvailability>, providers: DoctorReport['providers'] = []): DoctorReport =>
  ({ node: '22.20.0', electron: '44.0.0', platform: 'win32 x64', userData: 'C:\\userData', harnesses, providers }) as unknown as DoctorReport;

describe('formatDoctorReport', () => {
  it('names every harness with its state, version and location, and reads all-ready as informational', () => {
    const { text, level } = formatDoctorReport(
      report({
        claude: { available: true, version: '2.1.274', binaryPath: 'C:\\bin\\claude.exe', authenticated: true },
        native: { available: true, detail: 'Built in.', authenticated: 'unknown' }
      }),
      app
    );
    expect(level).toBe('info');
    expect(text).toContain('Vocs Code 0.9.3 · win32 x64 · Electron 44.0.0 · Node 22.20.0');
    expect(text).toContain('Harnesses (2 of 2 ready)');
    expect(text).toContain('  Claude Agent SDK · ok · 2.1.274 · C:\\bin\\claude.exe');
    // No binary path: the descriptor's own detail is the location.
    expect(text).toContain('  Native loop · ok · Built in.');
    expect(text).not.toContain('fix:');
  });

  it('marks a missing runtime, prints its installer, and warns', () => {
    const { text, level } = formatDoctorReport(
      report({ codex: { available: false, detail: 'Codex CLI not found.', installHint: 'npm install -g @openai/codex' } }),
      app
    );
    expect(level).toBe('warn');
    expect(text).toContain('Harnesses (0 of 1 ready)');
    expect(text).toContain('  Codex (app-server) · missing · Codex CLI not found. · fix: npm install -g @openai/codex');
  });

  it('calls out a signed-out runtime and the fix it carries', () => {
    const { text, level } = formatDoctorReport(
      report({
        cursor: {
          available: true,
          detail: 'Bundled @cursor/sdk (local runtime)',
          authenticated: false,
          installHint: 'Add a Cursor API key under Settings → Providers.'
        }
      }),
      app
    );
    expect(level).toBe('warn');
    expect(text).toContain('  Cursor · not logged in · Bundled @cursor/sdk (local runtime) · fix: Add a Cursor API key under Settings → Providers.');
  });

  it('distinguishes a stored key, an environment key and no key', () => {
    const { text } = formatDoctorReport(
      report({ native: { available: true } }, [
        { id: 'anthropic', name: 'Anthropic', hasKey: true, envKeyPresent: false },
        { id: 'openai', name: 'OpenAI', hasKey: false, envKeyPresent: true },
        { id: 'deepseek', name: 'DeepSeek', hasKey: false, envKeyPresent: false }
      ]),
      app
    );
    expect(text).toContain('  Anthropic · key stored');
    expect(text).toContain('  OpenAI · key from the environment');
    expect(text).toContain('  DeepSeek · no key');
  });

  it('flags a dev build and points at the userData directory and the full panel', () => {
    const { text } = formatDoctorReport(report({ native: { available: true } }), { version: '0.9.3', isPackaged: false });
    expect(text).toContain('Vocs Code 0.9.3 (dev build)');
    expect(text).toContain('Settings → About & doctor shows this as a table');
    expect(text).toContain('userData: C:\\userData');
  });
});
