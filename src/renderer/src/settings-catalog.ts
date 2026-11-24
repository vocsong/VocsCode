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
  { id: 'appearance', label: 'Appearance', icon: 'palette', group: 'Workspace', description: 'Find your focus with a layout and a theme that feel right.', saveHint: 'Interface and theme changes apply immediately', topics: [
    { label: 'Interface', description: 'Standard, or the minimalist Zen layout.', keywords: 'layout minimal minimalist zen focus compact clean simple distraction ui ux chrome', anchor: 'appearance-interface' },
    { label: 'Color theme', description: 'Light or dark mode, and twenty palettes that each come in both, with a live preview.', keywords: 'colors colour palette mode system light dark night appearance default graphite slate stone midnight navy abyss fjord admiral evergreen meadow lagoon citrine ember cappuccino solarium claret ultraviolet blossom dusk nebula blueprint porcelain lavender magma contrast', anchor: 'appearance-theme' },
    { label: 'Text & fonts', description: 'Interface size, interface, transcript and code fonts, text sizes, line spacing and transcript width.', keywords: 'font fonts typeface typography size zoom scale bigger smaller text size line spacing line height leading width narrow normal wide reading column monospace code font serif ligatures', anchor: 'appearance-typography' },
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
  { id: 'sessions', label: 'Session defaults', icon: 'sessionPlus', group: 'Agent behavior', description: 'Starting choices for new sessions, plus app-wide context, goal and Mission mode behavior.', saveHint: 'Preferences save automatically · Use Add for new branch prefixes', topics: [
    { label: 'New sessions', description: 'Default harness, permission mode and reasoning effort.', keywords: 'agent model permissions approval full access effort', anchor: 'sessions-defaults' },
    { label: 'Context management', description: 'Choose when to automatically compact a session.', keywords: 'context window tokens compaction threshold percentage', anchor: 'sessions-context' },
    { label: 'Goal defaults', description: 'Auto-continue, iteration guard and harness-native goals.', keywords: 'automatic autonomous goal iterations continue', anchor: 'sessions-goals' },
    { label: 'Mission mode', description: 'The harness, model, reasoning effort and permission mode every Mission Builder runs on.', keywords: 'mission lead builder builders same as lead harness model effort permission auto coordinate parallel', anchor: 'sessions-mission' },
    { label: 'Worktree branches', description: 'Manage the branch prefixes offered in every project.', keywords: 'git worktree isolation prefix branch', anchor: 'sessions-branches' },
  ] },
  { id: 'instructions', label: 'Instructions', icon: 'edit', group: 'Agent behavior', description: 'Tell your agents how you like to work. Shared rules, with room for exceptions.', saveHint: 'Use Save to apply your edits', topics: [
    { label: 'Shared & harness instructions', description: 'Edit the app’s global and per-harness instruction files, and the Mission Lead and Builder add-ons.', keywords: 'system prompt rules global markdown AGENTS CLAUDE APPEND_SYSTEM mission lead builder role', anchor: 'instructions-editor' },
  ] },
  { id: 'assistant', label: 'Vesta & utility', icon: 'sparkles', group: 'Agent behavior', description: 'Choose the models that help behind the scenes.', saveHint: AUTO, topics: [
    { label: 'Utility model', description: 'A fast model for session titles and worktree names.', keywords: 'background cheap naming flash model', anchor: 'assistant-models' },
    { label: 'Vesta assistant', description: 'Show or hide the floating assistant and choose its Pi model.', keywords: 'floating agent vesta pi assistant enabled', anchor: 'assistant-vesta' },
  ] },
  { id: 'account', label: 'Vocs account', icon: 'shield', group: 'Connections', description: 'Sign in with your Vocs account and connect the Hub connections it may use.', saveHint: 'Temporary, memory-only session', topics: [
    { label: 'Vocs sign-in', description: 'Connect your Vocs identity using the system browser, or sign out.', keywords: 'login auth identity account cancel logout staging production keep signed in remember persistent device', anchor: 'vocs-account-login' },
    { label: 'Hub connections', description: 'Connect your account’s MCP Hub connections so new agent sessions get their tools, or disconnect them.', keywords: 'mcp catalog cloud staging refresh connect disconnect openrouter hub oauth tools', anchor: 'vocs-account-catalog' },
  ] },
  { id: 'providers', label: 'Providers & keys', icon: 'key', group: 'Connections', description: 'Connect your models. Keep credentials in the OS keychain, not in configuration.', saveHint: 'Keys and new providers have explicit Save actions', topics: [
    { label: 'Providers & API keys', description: 'Enable providers, save or test keys and configure endpoints.', keywords: 'openai anthropic openrouter deepseek ollama lmstudio api key secrets base url custom', anchor: 'providers-catalog' },
    { label: 'Harness logins', description: 'Refresh models, check agent login status and available CLI updates.', keywords: 'login authentication credentials updates codex claude pi catalog reload google antigravity gemini quota', anchor: 'providers-logins' },
    { label: 'Model capability overrides', description: 'Correct whether a model accepts image attachments.', keywords: 'vision images models override capability', anchor: 'providers-overrides' },
  ] },
  { id: 'harnesses', label: 'Harnesses', icon: 'cpu', group: 'Connections', description: 'Your agent runtimes, in one place. Check availability, install and configure.', saveHint: AUTO, topics: [
    { label: 'Installed runtimes', description: 'Availability and installation for agent harnesses.', keywords: 'agents sdk runtime cli install update cursor native claude codex pi acp antigravity', anchor: 'harnesses-installed' },
    { label: 'Runtime configuration', description: 'Bundled vs system runtimes, binary paths and extra arguments.', keywords: 'binary path override extra arguments npx dsh gemini agy antigravity runtime', anchor: 'harnesses-config' },
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
  { id: 'housekeep', label: 'Housekeep', icon: 'archive', group: 'System', description: 'Choose how recently used sessions are protected when you run /housekeep.', saveHint: 'Changes save when you leave the field or press Enter', topics: [
    { label: 'Recent session protection', description: 'Keep recently used sessions out of cleanup.', keywords: '/housekeep archive age guard protect sessions days', anchor: 'housekeep-recent' },
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
