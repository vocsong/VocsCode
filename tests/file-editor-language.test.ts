import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, highlightingFor, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter, tags } from '@lezer/highlight';
import { fileLanguage, loadFileLanguage } from '../src/renderer/src/file-editor-language';

describe('file editor language selection', () => {
  it.each([
    ['src/Example.TSX', 'TSX'], ['G:\\project\\main.mts', 'TypeScript'], ['index.js', 'JavaScript'],
    ['guide.md', 'Markdown'], ['settings.jsonc', 'JSON'], ['pipeline.yml', 'YAML'],
    ['style.css', 'CSS'], ['script.py', 'Python'], ['src/main.rs', 'Rust'], ['compose.Dockerfile', 'Dockerfile'],
    ['.bashrc', 'Shell'], ['.env.local', 'Properties files'], ['Cargo.lock', 'TOML'],
  ])('matches %s as %s', (path, name) => {
    expect(fileLanguage(path)?.name).toBe(name);
  });

  it('uses plain text for unrecognized filenames', async () => {
    expect(fileLanguage('LICENSE')).toBeNull();
    expect(fileLanguage('constructor')).toBeNull();
    expect(await loadFileLanguage('LICENSE')).toEqual([]);
  });

  it('loads a grammar that parses JSX in TypeScript source', async () => {
    const text = 'const view: JSX.Element = <div title="hello" />;';
    const state = EditorState.create({ doc: text, extensions: [await loadFileLanguage('example.tsx'), syntaxHighlighting(classHighlighter)] });
    const tree = ensureSyntaxTree(state, text.length);
    expect(tree?.toString()).toContain('JSXSelfClosingTag');
    expect(highlightingFor(state, [tags.keyword])).toBe('tok-keyword');
    expect(highlightingFor(state, [tags.string])).toBe('tok-string');
  });
});
