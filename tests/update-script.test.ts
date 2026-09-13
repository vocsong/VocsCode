import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');

describe('update script', () => {
  it('installs production and development dependencies before rebuilding', () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.update).toBe(
      'git pull && npm install --include=dev && npm run build && npm start',
    );
  });
});
