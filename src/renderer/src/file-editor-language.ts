/** Language packs stay off the startup path and only the selected grammar is loaded. */
import type { Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

const specialFiles = new Map(Object.entries({
  '.bashrc': 'Shell', '.bash_profile': 'Shell', '.profile': 'Shell', '.zshrc': 'Shell',
  '.gitconfig': 'Properties files', '.editorconfig': 'Properties files', '.npmrc': 'Properties files',
  '.env': 'Properties files', '.prettierrc': 'JSON', '.eslintrc': 'JSON',
  'cargo.lock': 'TOML', 'yarn.lock': 'YAML',
}));

export function fileLanguage(path: string): LanguageDescription | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  const special = specialFiles.get(name) ?? (/^(?:.+\.)?dockerfile(?:\..+)?$/.test(name) ? 'Dockerfile'
    : /^\.env\./.test(name) ? 'Properties files'
    : /\.(?:cts|mts)$/.test(name) ? 'TypeScript'
    : /\.jsonc$/.test(name) ? 'JSON' : undefined);
  return special
    ? LanguageDescription.matchLanguageName(languages, special, false)
    : LanguageDescription.matchFilename(languages, name);
}

export async function loadFileLanguage(path: string): Promise<Extension> {
  const grammar = fileLanguage(path);
  return grammar ? grammar.load() : [];
}
