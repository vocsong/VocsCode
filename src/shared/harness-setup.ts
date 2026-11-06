/** First-run terminology and read-only setup results. No credentials cross this boundary. */
import type { HarnessAvailability, HarnessId } from './types';

export type InstallableHarnessId = 'claude' | 'codex' | 'pi' | 'dsh';
export type LoginHarnessId = 'claude' | 'codex' | 'pi';
export interface SetupRequirement {
  id: 'sdk' | 'node' | 'npm' | 'git';
  name: string;
  available: boolean;
  detail: string;
  url?: string;
}
export interface ProviderAccess {
  id: string;
  source: 'stored' | 'environment' | 'local' | 'none';
}
export interface HarnessSetupStatus {
  harness: HarnessId;
  availability: HarnessAvailability;
  requirements: SetupRequirement[];
  providers: ProviderAccess[];
  /** Installation repairs a missing CLI, not a missing SDK or a pinned runtime selection. */
  installId?: InstallableHarnessId;
  canInstall: boolean;
  installReason?: string;
  loginId?: LoginHarnessId;
  /** Codex also receives configured app/environment API keys; CLI status alone cannot prove billing. */
  apiCredentialsMayOverrideLogin?: boolean;
}

export const INSTALL_HARNESS: Partial<Record<HarnessId, InstallableHarnessId>> = {
  claude: 'claude', codex: 'codex', 'codex-exec': 'codex', pi: 'pi', acp: 'dsh'
};
export const LOGIN_HARNESS: Partial<Record<HarnessId, LoginHarnessId>> = {
  claude: 'claude', codex: 'codex', 'codex-exec': 'codex', pi: 'pi'
};

/** A runnable binary and an unknown login must never be presented as a ready account. */
export function harnessStatus(harness: HarnessId, status?: HarnessAvailability): { label: string; tone: 'neutral' | 'green' | 'amber' | 'red' } {
  if (!status) return { label: 'Checking…', tone: 'neutral' };
  if (!status.available) return { label: 'Setup needed', tone: 'red' };
  if (harness === 'native') return { label: 'Built in', tone: 'neutral' };
  if (status.authenticated === true) return { label: status.authMethod === 'subscription' ? 'Subscription sign-in detected' : status.authMethod === 'api-key' ? 'API credentials configured' : 'Credentials detected', tone: 'green' };
  if (status.authenticated === false) return { label: 'Sign-in needed', tone: 'amber' };
  return { label: 'Sign-in not verified', tone: 'amber' };
}
