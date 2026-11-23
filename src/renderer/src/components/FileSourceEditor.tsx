import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { loadFileLanguage } from '../file-editor-language';
import './file-editor.css';

interface Props {
  path: string;
  text: string;
  readOnly: boolean;
  scrollLine: { line: number } | null;
  onLineRevealed: () => void;
  onChange: (text: string) => void;
  onSave: (text: string) => void;
}

const fromPreview = Annotation.define<boolean>();
const editing = new Compartment();
const language = new Compartment();
const editingMode = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
const baseExtensions = [
  EditorView.contentAttributes.of({ 'aria-label': 'File contents', tabindex: '0' }),
  EditorState.tabSize.of(4),
  lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(),
  history(), drawSelection(), highlightSpecialChars(), indentOnInput(), bracketMatching(),
  syntaxHighlighting(classHighlighter),
  // Escape belongs to the drawer, and Tab must still be able to leave the editor.
  keymap.of([...defaultKeymap.filter(({ key }) => key !== 'Escape'), ...historyKeymap]),
];

/** The preview owns persisted text and drafts; the view owns interaction and undo history. */
export function FileSourceEditor(props: Props) {
  const { path, text, readOnly, scrollLine } = props;
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef(props);
  const publishedText = useRef(text);
  useLayoutEffect(() => { callbacks.current = props; });

  useLayoutEffect(() => {
    const host = parent.current;
    if (!host) return;
    const initial = callbacks.current;
    publishedText.current = initial.text;
    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.text,
        extensions: [
          baseExtensions,
          editing.of(editingMode(initial.readOnly)),
          language.of([]),
          EditorState.changeFilter.of((tr) => !tr.startState.readOnly || !!tr.annotation(fromPreview)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.some((tr) => tr.annotation(fromPreview))) return;
            publishedText.current = update.state.doc.toString();
            callbacks.current.onChange(publishedText.current);
          }),
          EditorView.domEventHandlers({
            keydown(event, current) {
              if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return false;
              event.stopPropagation();
              // CodeMirror flushes pending DOM input before this handler runs; React may not
              // yet have committed the corresponding draft update in the same key event.
              callbacks.current.onSave(current.state.doc.toString());
              return true;
            },
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const replace = text !== publishedText.current;
    const reconfigure = readOnly !== editor.state.readOnly;
    if (!replace && !reconfigure) return;
    publishedText.current = text;
    editor.dispatch({
      changes: replace ? { from: 0, to: editor.state.doc.length, insert: text } : undefined,
      annotations: [fromPreview.of(true), Transaction.addToHistory.of(false)],
      effects: reconfigure ? editing.reconfigure(editingMode(readOnly)) : undefined,
    });
  }, [text, readOnly]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || !scrollLine) return;
    const { from } = editor.state.doc.line(Math.min(scrollLine.line, editor.state.doc.lines));
    editor.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    callbacks.current.onLineRevealed();
  }, [scrollLine]);

  useEffect(() => {
    const editor = view.current;
    let cancelled = false;
    void loadFileLanguage(path).then((extension) => {
      if (!cancelled) editor?.dispatch({ effects: language.reconfigure(extension) });
    }).catch(() => { /* If a grammar fails to load, keep the plain text editor usable. */ });
    return () => { cancelled = true; };
  }, [path]);

  return <div ref={parent} className="file-source-editor" />;
}
