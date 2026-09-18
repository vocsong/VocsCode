/**
 * Vocs Code's Pi search and listing tools: `rg`, `glob` and `ls`.
 *
 * Pi implements all three as built-ins (`grep`, `find`, `ls`) but activates only read/bash/edit/write
 * by default, so a Pi session otherwise shells out for `ls`, `rg` and `find`. Registering Pi's own
 * definitions under Vocs Code's names makes them extension tools instead: extension tools are active
 * by default, they still honour `--tools`, `--exclude-tools` and `--no-tools`, and their behaviour is
 * Pi's — schema, execution and rendering are reused unchanged.
 */
import { prepareToolArguments, TOOL_GUIDELINES, type CompatibleTool } from './tool-arguments';

export type SearchToolName = 'rg' | 'glob' | 'ls';

export const SEARCH_TOOL_NAMES: SearchToolName[] = ['rg', 'glob', 'ls'];

/** The subset of Pi's ToolDefinition this module touches, kept structural for the desktop build. */
export interface PiToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => unknown;
  execute: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export interface SearchToolSdk {
  createGrepToolDefinition(cwd: string): PiToolDefinition;
  createFindToolDefinition(cwd: string): PiToolDefinition;
  createLsToolDefinition(cwd: string): PiToolDefinition;
}

/** Build the three definitions from Pi's own built-ins, renamed and documented for Vocs Code. */
export function createSearchToolDefinitions(sdk: SearchToolSdk, cwd: string): PiToolDefinition[] {
  const sources: Record<SearchToolName, () => PiToolDefinition> = {
    rg: () => sdk.createGrepToolDefinition(cwd),
    glob: () => sdk.createFindToolDefinition(cwd),
    ls: () => sdk.createLsToolDefinition(cwd),
  };
  return SEARCH_TOOL_NAMES.map((name) => {
    const original = sources[name]();
    const guideline = TOOL_GUIDELINES[name];
    return {
      ...original,
      name,
      label: name,
      description: `${original.description}\n${guideline}`,
      promptGuidelines: [...(original.promptGuidelines ?? []), guideline],
      prepareArguments(args: unknown) {
        const prepared = prepareToolArguments(name as CompatibleTool, args);
        return original.prepareArguments ? original.prepareArguments(prepared) : prepared;
      },
    };
  });
}
