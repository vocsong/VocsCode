/**
 * Settings section deep-link navigation state, kept outside SettingsView so child
 * sections (e.g. VoiceSettings) and dialogs can jump to a section without forming
 * circular imports with SettingsView.
 */
import type { SettingsSection } from './settings-catalog';
import { useStore } from './store';

let requestedSection: SettingsSection | null = null;
const sectionListeners = new Set<(section: SettingsSection) => void>();

/** Deep links ("Configure Mission") land on their section, whether or not Settings is open. */
export function openSettings(section: SettingsSection): void {
  requestedSection = section;
  for (const listener of sectionListeners) listener(section);
  useStore.getState().setView('settings');
}

export function peekRequestedSettingsSection(): SettingsSection | null {
  return requestedSection;
}

export function clearRequestedSettingsSection(): void {
  requestedSection = null;
}

export function subscribeSettingsSection(listener: (section: SettingsSection) => void): () => void {
  sectionListeners.add(listener);
  return () => {
    sectionListeners.delete(listener);
  };
}
