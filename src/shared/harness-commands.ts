/**
 * Slash commands a harness answers itself — Claude Code's commands and skills, Pi's prompt templates,
 * skills and extension commands, an ACP agent's advertised commands, Codex's skills — and the rules
 * the composer uses to offer them beside the app's own `SLASH_COMMANDS`.
 *
 * The app's commands keep their namespace (see the wiki page "App-owned slash commands shadow the
 * harness's own"): a harness command whose name an app command already takes is reached with a
 * doubled slash, `//name`, which the composer sends to the harness as `/name`.
 *
 * Keep this file free of Node/Electron/DOM imports.
 */

/** Where a harness command comes from, shown as a badge so a skill is not mistaken for a built-in. */
export type HarnessCommandKind = 'command' | 'skill' | 'prompt' | 'extension';

export interface HarnessCommand {
  /** Typed after the slash, without it: `review`, `skill:pdf`, `my-plugin:deploy`. */
  name: string;
  description?: string;
  /** What goes after the name, e.g. `<file>` or `[focus]`; empty when it takes nothing. */
  argumentHint?: string;
  /** Other names the harness accepts for the same command. */
  aliases?: string[];
  kind?: HarnessCommandKind;
}

/** A harness that advertises hundreds of skills must not turn every session push into a megabyte. */
export const MAX_HARNESS_COMMANDS = 400;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 240;
const MAX_HINT = 80;
const NAME = /^[\w][\w:.\-/]*$/;

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A command name as the user types it: no leading slash, no whitespace. Null when unusable. */
export function commandName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/^\/+/, '');
  return name && name.length <= MAX_NAME && NAME.test(name) ? name : null;
}

/**
 * The list as the session keeps it: names checked, text flattened and clipped, duplicates (by
 * lower-cased name) dropped keeping the first, and the total capped. Order is the harness's own.
 */
export function normalizeHarnessCommands(input: readonly HarnessCommand[]): HarnessCommand[] {
  const out: HarnessCommand[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= MAX_HARNESS_COMMANDS) break;
    const name = commandName(raw?.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const command: HarnessCommand = { name };
    const description = clip(raw.description, MAX_DESCRIPTION);
    if (description) command.description = description;
    const hint = clip(raw.argumentHint, MAX_HINT);
    if (hint) command.argumentHint = hint;
    const aliases = (raw.aliases ?? []).map(commandName).filter((a): a is string => !!a && a.toLowerCase() !== name.toLowerCase());
    if (aliases.length) command.aliases = [...new Set(aliases)];
    if (raw.kind) command.kind = raw.kind;
    out.push(command);
  }
  return out;
}

/** Every name the harness answers to — aliases included, lower-cased, de-duplicated (the goal driver's input). */
export function harnessCommandNames(commands: readonly HarnessCommand[]): string[] {
  const out: string[] = [];
  for (const c of commands) {
    for (const raw of [c.name, ...(c.aliases ?? [])]) {
      const name = raw.trim().toLowerCase();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

export function sameHarnessCommands(a: readonly HarnessCommand[] | undefined, b: readonly HarnessCommand[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i];
    return c.name === d.name && c.description === d.description && c.argumentHint === d.argumentHint && c.kind === d.kind && (c.aliases ?? []).join('\0') === (d.aliases ?? []).join('\0');
  });
}

/** One row of the composer's `/` popover. */
export interface SlashEntry {
  /** What the row inserts after the leading slash: `review`, or `/pr` for a shadowed harness command. */
  insert: string;
  /** Shown name, always with one slash: `/review`. */
  label: string;
  description?: string;
  args?: string;
  source: 'app' | 'harness';
  kind?: HarnessCommandKind;
  /** A harness command whose name an app command takes; it is reached as `//name`. */
  shadowed?: boolean;
}

/**
 * Popover rows for a typed `/query`, app commands first (Tab takes the first row, so `/m` stays
 * `/model`), then the harness's own — the other way round for a bare `/`. A harness row matches on a prefix of its name, an alias, or a
 * `:`-separated segment (`/pdf` finds Pi's `skill:pdf`), and then on any substring, in that order.
 *
 * `delegated` names app commands that already forward to the harness's command of the same name
 * (`/compact`), so the harness duplicate adds nothing and is left out. `nativeGoal` is the command
 * the session hands to the harness (shared/goal-driver.ts): the harness row is then the real one and
 * the app row is dropped.
 */
export function slashEntries(input: {
  query: string;
  app: readonly { name: string; description: string; args?: string }[];
  harness: readonly HarnessCommand[];
  delegated?: readonly string[];
  nativeGoal?: string | null;
}): SlashEntry[] {
  const q = input.query.toLowerCase();
  const native = input.nativeGoal?.toLowerCase();
  const appNames = new Set(input.app.map((c) => c.name.toLowerCase()));
  const appRows: SlashEntry[] = input.app
    .filter((c) => c.name.toLowerCase().startsWith(q) && c.name.toLowerCase() !== native)
    .map((c) => ({ insert: c.name, label: `/${c.name}`, description: c.description, args: c.args, source: 'app' }));
  const ranked: { rank: number; entry: SlashEntry }[] = [];
  for (const c of input.harness) {
    const lower = c.name.toLowerCase();
    if (input.delegated?.some((d) => d.toLowerCase() === lower)) continue;
    const rank = matchRank(c, q);
    if (rank < 0) continue;
    const shadowed = appNames.has(lower) && lower !== native;
    ranked.push({
      rank,
      entry: { insert: shadowed ? `/${c.name}` : c.name, label: `/${c.name}`, description: c.description, args: c.argumentHint, source: 'harness', kind: c.kind, shadowed: shadowed || undefined }
    });
  }
  // Stable: equal ranks keep the harness's own order.
  ranked.sort((a, b) => a.rank - b.rank);
  const harnessRows = ranked.map((r) => r.entry);
  // A bare `/` is the user browsing: the commands only this session's harness has come first, since
  // the app's are the same everywhere and would push them out of view. Once a name is typed the app
  // leads again, so `/m` + Tab stays `/model` on every harness.
  return q ? [...appRows, ...harnessRows] : [...harnessRows, ...appRows];
}

function matchRank(c: HarnessCommand, q: string): number {
  if (!q) return 0;
  const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  if (names[0].startsWith(q)) return 0;
  if (names.some((n) => n.startsWith(q) || n.split(':').some((part) => part.startsWith(q)))) return 1;
  return names.some((n) => n.includes(q)) ? 2 : -1;
}

/**
 * The text that reaches the harness for a typed line. `//name …` is the explicit route to a harness
 * command an app command shadows, so it loses one slash; anything else goes verbatim. Only names the
 * app owns are rewritten — a message that merely begins with `//` (a code comment) is left alone.
 */
export function harnessRoutedText(line: string, appCommands: readonly string[]): string | null {
  const m = /^\/\/([\w][\w:.\-/]*)(?=\s|$)/.exec(line);
  if (!m || !appCommands.some((c) => c.toLowerCase() === m[1].toLowerCase())) return null;
  return line.slice(1);
}
