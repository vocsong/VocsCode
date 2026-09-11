import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const iconDir = path.join(root, 'resources', 'icons');

function readIcon(name: string): Buffer {
  const file = path.join(iconDir, name);
  expect(statSync(file).isFile()).toBe(true);
  return readFileSync(file);
}

describe('application branding', () => {
  it('uses Vocs Code as the display name everywhere packaging needs it', () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { productName?: string };
    const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

    expect(packageJson.productName).toBe('Vocs Code');
    expect(builder).toContain('productName: Vocs Code');
    expect(builder).toContain('shortcutName: Vocs Code');
    expect(builder).toContain('icon: resources/icons/vocs-code.ico');
    expect(builder).toContain('icon: resources/icons/vocs-code.icns');
    expect(builder).toContain('icon: resources/icons/vocs-code.png');
  });

  it('ships valid native icon formats from the same artwork', () => {
    const png = readIcon('vocs-code.png');
    const ico = readIcon('vocs-code.ico');
    const icns = readIcon('vocs-code.icns');

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(512);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(5);
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
  });

  it('writes the dev Start Menu shortcut with an icon and a first-run create fallback', () => {
    // shell.writeShortcutLink silently drops `icon` unless iconIndex is set, and 'replace'
    // fails when the shortcut does not exist yet — either way the taskbar loses its icon.
    const source = readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    const fn = source.match(/function reconcileDevShortcut[\s\S]*?\n\}/);
    expect(fn, 'reconcileDevShortcut must exist').not.toBeNull();
    expect(fn![0]).toContain('icon: appIconPath(appRoot)');
    expect(fn![0]).toContain('iconIndex: 0');
    expect(fn![0]).toContain("existsSync(lnk) ? 'replace' : 'create'");
  });
});
