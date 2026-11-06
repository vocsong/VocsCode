/** Settings information architecture and local search index. No settings values or secrets are indexed. */
export const SETTINGS_GROUPS = ['Workspace', 'Agent behavior', 'Connections', 'System'] as const;
type SettingsCategory = (typeof SETTINGS_GROUPS)[number];

export interface SettingsTopic {
  label: string;
  description: string;
  keywords?: string;
  anchor?: string;
}
interface SettingsPage {
  id: string;
  label: string;
  icon: string;
  group: SettingsCategory;
  description: string;
  saveHint: string;
  topics: SettingsTopic[];
}
const AUTO = 'Preferences save automatically';

export const SETTINGS_PAGES = [
  { id: 'general', label: 'General', icon: 'settings', group: 'Workspace', description: 'Your everyday preferences. Make this workspace work for you.', saveHint: AUTO, topics: [
    { label: 'Notifications', description: 'Desktop alerts when a turn finishes or needs your approval.', keywords: 'notification unfocused background', anchor: 'general-notifications' },
    { label: 'External editor', description: 'Choose the command used by Open in editor.', keywords: 'vscode code editor command', anchor: 'general-editor' },
  ] },
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'Workspace', description: 'Find your focus with a theme that feels right.', saveHint: 'Theme changes apply immediately', topics: [
    { label: 'Color theme', description: 'System, light, dark and expressive themes with a live preview.', keywords: 'colors colour midnight navy abyss blueprint admiral nebula ultraviolet magma solarium blossom citrine cappuccino meadow porcelain lavender evergreen graphite ember lagoon fjord claret contrast', anchor: 'appearance-theme' },
  ] },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', group: 'Workspace', description: 'Less reaching for the mouse. More staying in flow.', saveHint: 'Use Add to save a new shortcut', topics: [
    { label: 'Custom shortcuts', description: 'Bind your own key combinations to common actions.', keywords: 'keyboard hotkeys bindings command', anchor: 'shortcuts-custom' },
    { label: 'Built-in shortcuts', description: 'A reference for the app’s reserved key combinations.', keywords: 'keyboard keys terminal copy paste', anchor: 'shortcuts-reference' },
  ] },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', group: 'Workspace', description: 'A familiar shell, tuned to the way you work.', saveHint: AUTO, topics: [
    { label: 'Shell & startup', description: 'Default shell, custom executable and terminal restoration.', keywords: 'powershell bash zsh arguments restore startup', anchor: 'terminal-shell' },
    { label: 'Text & cursor', description: 'Font size, scrollback history and cursor style.', keywords: 'blinking lines font size cursor scrollback', anchor: 'terminal-display' },
  ] },
  { id: 'voice', label: 'Voice', icon: 'mic', group: 'Workspace', description: 'Turn spoken ideas into text, locally or with a cloud provider.', saveHint: AUTO, topics: [
    { label: 'Dictation engine & language', description: 'Choose where speech is transcribed and which language to expect.', keywords: 'microphone mic speech language cloud local', anchor: 'voice-engine' },
    { label: 'Cloud transcription', description: 'Speech provider and transcription model.', keywords: 'audio speech api cloud', anchor: 'voice-cloud' },
    { label: 'Local transcription', description: 'Private, on-device whisper.cpp models, GPU and idle timeout.', keywords: 'whisper cpu gpu download microphone local idle server', anchor: 'voice-local' },
  ] },
  { id: 'sessions', label: 'Session defaults', icon: 'sessionPlus', group: 'Agent behavior', description: 'A starting point for new projects. Each project can remember its own choices.', saveHint: 'Preferences save automatically · Use Add for new branch prefixes', topics: [
    { label: 'New sessions', description: 'Default harness, permission mode and reasoning effort.', keywords: 'agent model permissions approval full access effort', anchor: 'sessions-defaults' },
    { label: 'Context management', description: 'Choose when to automatically compact a session.', keywords: 'context window tokens compaction threshold percentage', anchor: 'sessions-context' },
    { label: 'Goal defaults', description: 'Auto-continue, iteration guard and harness-native goals.', keywords: 'automatic autonomous goal iterations continue', anchor: 'sessions-goals' },
    { label: 'Worktree branches', description: 'Manage the branch prefixes offered in every project.', keywords: 'git worktree isolation prefix branch', anchor: 'sessions-branches' },
  ] },
  { id: 'instructions', label: 'Instructions', icon: 'edit', group: 'Agent behavior', description: 'Tell your agents how you like to work. Shared rules, with room for exceptions.', saveHint: 'Use Save to apply your edits', topics: [
    { label: 'Shared & harness instructions', description: 'Edit the app’s global and per-harness instruction files.', keywords: 'system prompt rules global markdown AGENTS CLAUDE APPEND_SYSTEM', anchor: 'instructions-editor' },
  ] },
  { id: 'mission', label: 'Mission', icon: 'flag', group: 'Agent behavior', description: 'Build your agent team. Set model pools, working limits and project overrides.', saveHint: 'Use Save Mission settings to apply edits', topics: [
    { label: 'Mission model pools', description: 'Tier assignments, presets and the default principal engineer.', keywords: 'T1 T2 T3 T4 T5 workers lead tier preset model pools' },
    { label: 'Mission limits & projects', description: 'Concurrency, account capacity, budgets and project overrides.', keywords: 'budget cost tokens capacity limits account project delegation', anchor: 'mission-limits' },
  ] },
  { id: 'assistant', label: 'Vesta & utility', icon: 'sparkles', group: 'Agent behavior', description: 'Choose the models that help behind the scenes.', saveHint: AUTO, topics: [
    { label: 'Utility model', description: 'A fast model for session titles and worktree names.', keywords: 'background cheap naming flash model', anchor: 'assistant-models' },
    { label: 'Vesta assistant', description: 'Show or hide the floating assistant and choose its Pi model.', keywords: 'floating agent vesta pi assistant enabled', anchor: 'assistant-vesta' },
  ] },
  { id: 'providers', label: 'Providers & keys', icon: 'key', group: 'Connections', description: 'Connect your models. Keep credentials in the OS keychain, not in configuration.', saveHint: 'Keys and new providers have explicit Save actions', topics: [
    { label: 'Providers & API keys', description: 'Enable providers, save or test keys and configure endpoints.', keywords: 'openai anthropic openrouter deepseek ollama lmstudio api key secrets base url custom', anchor: 'providers-catalog' },
    { label: 'Harness logins', description: 'Check agent login status and available CLI updates.', keywords: 'login authentication credentials updates codex claude pi', anchor: 'providers-logins' },
    { label: 'Model capability overrides', description: 'Correct whether a model accepts image attachments.', keywords: 'vision images models override capability', anchor: 'providers-overrides' },
  ] },
  { id: 'harnesses', label: 'Harnesses', icon: 'cpu', group: 'Connections', description: 'Your agent runtimes, in one place. Check availability, install and configure.', saveHint: AUTO, topics: [
    { label: 'Installed runtimes', description: 'Availability and installation for all seven agent harnesses.', keywords: 'agents sdk runtime cli install update cursor native claude codex pi acp', anchor: 'harnesses-installed' },
    { label: 'Runtime configuration', description: 'Bundled vs system runtimes, binary paths and extra arguments.', keywords: 'binary path override extra arguments npx dsh gemini runtime', anchor: 'harnesses-config' },
  ] },
  { id: 'pi', label: 'Pi', icon: 'puzzle', group: 'Connections', description: 'Fine-tune Pi’s own configuration, extensions and agent tools.', saveHint: 'File editors have explicit Save actions', topics: [
    { label: 'Pi configuration', description: 'Models, packages, prompts, skills and extension settings.', keywords: 'packages extensions subagents concurrency skills prompts compaction retry thinking steering followup pi' },
  ] },
  { id: 'acp', label: 'ACP agents', icon: 'fork', group: 'Connections', description: 'Bring any agent that speaks the Agent Client Protocol.', saveHint: 'Use Save when editing an agent', topics: [
    { label: 'ACP agent presets', description: 'Add or edit commands and arguments for external agents.', keywords: 'stdio acp dsh deepseek gemini preset command' },
  ] },
  { id: 'import', label: 'Import chats', icon: 'download', group: 'System', description: 'Bring your earlier conversations along, without changing the originals.', saveHint: 'Review your selection before importing', topics: [
    { label: 'Import chat history', description: 'Scan and import existing Claude Code and Codex conversations.', keywords: 'history migration import chats scan conversations' },
  ] },
  { id: 'remote', label: 'Remote access', icon: 'globe', group: 'System', description: 'Your workspace, wherever you are. You stay in control of who can connect.', saveHint: 'Access changes require explicit actions', topics: [
    { label: 'Browser access & pairing', description: 'Connect this computer, pair a browser and manage devices.', keywords: 'phone mobile qr github login relay pair remote devices view only offline mirror', anchor: 'remote-browser' },
    { label: 'External controllers', description: 'Manage desktop grants and remote MCP control.', keywords: 'control controller mcp oauth grants permissions access', anchor: 'remote-controllers' },
  ] },
  { id: 'about', label: 'About & doctor', icon: 'info', group: 'System', description: 'Version details, updates and a health check for your setup.', saveHint: 'Diagnostics are read-only', topics: [
    { label: 'About & updates', description: 'App version, runtime versions, data folder and updates.', keywords: 'electron node version upgrade restart data folder' },
    { label: 'Doctor', description: 'Diagnose missing harnesses and provider configuration.', keywords: 'diagnostics health missing troubleshooting doctor', anchor: 'about-doctor' },
  ] },
] as const satisfies readonly SettingsPage[];

export type SettingsSection = (typeof SETTINGS_PAGES)[number]['id'];
export interface SettingsSearchResult { section: SettingsSection; pageLabel: string; group: string; icon: string; topic: SettingsTopic }

export function searchSettings(query: string): SettingsSearchResult[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return SETTINGS_PAGES.flatMap((page) => page.topics
    .filter((topic: SettingsTopic) => {
      const text = `${page.label} ${topic.label} ${topic.description} ${topic.keywords ?? ''}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .map((topic) => ({ section: page.id, pageLabel: page.label, group: page.group, icon: page.icon, topic })));
}
