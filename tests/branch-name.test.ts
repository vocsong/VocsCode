/**
 * Worktree branch names follow what the first prompt asks for, not its first characters: a slug of
 * "Can you please fix the login redirect…" used to name `can-you-please-fix-the-login-redirect-w`.
 * Without a model, the opener and filler words are dropped; a model's reply is cleaned to the same
 * shape, and its type prefix is dropped because the user picks that separately.
 */
import { describe, expect, it } from 'vitest';
import { branchNameFromText, sanitizeBranchNameReply } from '../src/shared/branch-prefix';

describe('branchNameFromText', () => {
  it('names the intent of a prompt, dropping how it was asked and the filler words', () => {
    expect(branchNameFromText('Can you please fix the login redirect bug when users sign in with Google')).toBe('fix-login-redirect-bug-users');
    expect(branchNameFromText('I want to add a dark mode toggle to the settings page.')).toBe('add-dark-mode-toggle-settings');
    expect(branchNameFromText('Hey, could you help me refactor the session manager?')).toBe('refactor-session-manager');
    expect(branchNameFromText('Why does the build fail on Windows')).toBe('build-fail-windows');
  });

  it('keeps the verb that carries the intent and reads only the first sentence', () => {
    expect(branchNameFromText('Make the sidebar collapsible. It should remember its state.')).toBe('make-sidebar-collapsible');
    expect(branchNameFromText('\n\nFix login redirect\nmore detail here')).toBe('fix-login-redirect');
  });

  it('stays within the length limit by dropping a word, never cutting one', () => {
    const name = branchNameFromText('Internationalize authentication configuration documentation thoroughly');
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toBe('internationalize-authentication');
  });

  it('falls back to the plain slug when only filler is left', () => {
    expect(branchNameFromText('the')).toBe('the');
    expect(branchNameFromText('!!!')).toBe('session');
  });
});

describe('sanitizeBranchNameReply', () => {
  it('takes the name out of quoting, a preamble and a type prefix', () => {
    expect(sanitizeBranchNameReply('feat/fix-login-redirect')).toBe('fix-login-redirect');
    expect(sanitizeBranchNameReply('"Branch name: add-dark-mode-toggle"')).toBe('add-dark-mode-toggle');
    expect(sanitizeBranchNameReply('`refactor-session-manager`\nBecause the request…')).toBe('refactor-session-manager');
    expect(sanitizeBranchNameReply('Migrate Auth To OAuth')).toBe('migrate-auth-to-oauth');
  });

  it('rejects an empty reply and leaked control-token markup', () => {
    expect(sanitizeBranchNameReply('')).toBeNull();
    expect(sanitizeBranchNameReply('  ')).toBeNull();
    expect(sanitizeBranchNameReply('<|im_start|>assistant')).toBeNull();
  });
});
