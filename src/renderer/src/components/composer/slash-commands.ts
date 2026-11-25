/** Local app slash-command dispatcher for the Composer (`/help`, `/doctor`, `/model`, `/pr`, etc.). */
import type { EffortLevel, ModelInfo, PermissionMode, ProviderConfig, SessionMeta } from '../../../../shared/types';
import { formatDoctorReport } from '../../../../shared/doctor';
import { HARNESS_BY_ID, SLASH_COMMANDS, effortOptionsFor } from '../../../../shared/harness-meta';
import { slashEntries, type HarnessCommand } from '../../../../shared/harness-commands';
import { parseTypedModel } from '../../../../shared/model-names';
import { invoke } from '../../api';
import { fmtCost, fmtTokens } from '../../format';
import { setSessionEffort } from '../../sessionActions';
import { useStore } from '../../store';

export interface SlashCommandContext {
  session: SessionMeta;
  harness: (typeof HARNESS_BY_ID)[SessionMeta['config']['harness']];
  currentInfo: ModelInfo | undefined;
  providers: readonly ProviderConfig[];
  harnessCommands: HarnessCommand[];
  harnessNote: string | null;
  nativeGoal: 'goal' | undefined;
  toast: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

export async function runComposerSlashCommand(cmd: string, rest: string[], ctx: SlashCommandContext): Promise<boolean> {
  const { session, harness, currentInfo, providers, harnessCommands, harnessNote, nativeGoal, toast } = ctx;
  const caps = harness.capabilities;
  const arg = rest.join(' ').trim();
  const store = useStore.getState();

  switch (cmd) {
    case 'help': {
      // A transcript note, not a toast: with a harness's skills listed it runs to many lines.
      const own = slashEntries({ query: '', app: SLASH_COMMANDS, harness: harnessCommands, delegated: ['compact'], nativeGoal }).filter((c) => c.source === 'harness');
      const lines = [
        `Vocs Code: ${SLASH_COMMANDS.map((c) => '/' + c.name).join(' ')}`,
        own.length ? `${harness.name}: ${own.map((c) => '/' + c.insert).join(' ')}` : harnessNote ?? '',
        ...(own.some((c) => c.shadowed) ? [`A doubled slash (//name) runs ${harness.name}'s own command where Vocs Code has one of the same name.`] : []),
        'Enter send · Shift+Enter newline · Esc stop · ! shell · @ files · Ctrl+K palette'
      ].filter(Boolean);
      store.setLocalInfo(session.id, `local-help-${session.id}`, lines.join('\n'));
      return true;
    }
    case 'doctor': {
      // Runtimes are probed live (each probe can cost a process spawn), so the note shows up right
      // away and is replaced by the report. Renderer-local like the other command notes: it is a
      // reading of this machine at this moment, not part of the conversation.
      const noteId = `local-doctor-${session.id}`;
      store.setLocalInfo(session.id, noteId, 'Checking harness runtimes and provider keys…', { pending: true });
      try {
        const [info, report] = await Promise.all([invoke('app:info', undefined), invoke('app:doctor', undefined)]);
        const { text, level } = formatDoctorReport(report, info);
        store.setLocalInfo(session.id, noteId, text, { level });
      } catch (e) {
        store.setLocalInfo(session.id, noteId, `Doctor failed: ${String((e as Error).message ?? e)}`, { level: 'error' });
      }
      return true;
    }
    case 'model': {
      if (!arg) {
        toast('Usage: /model provider/model', 'error');
        return true;
      }
      const ref = parseTypedModel(arg, providers.map((p) => p.id), session.activeModel?.provider ?? 'anthropic');
      await invoke('sessions:setModel', { id: session.id, model: ref }).catch((e) => toast(String(e.message ?? e), 'error'));
      return true;
    }
    case 'mode':
      if (!caps.permissionModes.includes(arg as PermissionMode)) {
        toast(`Modes: ${caps.permissionModes.join(', ')}`, 'error');
        return true;
      }
      await invoke('sessions:setPermissionMode', { id: session.id, mode: arg as PermissionMode });
      return true;
    case 'effort': {
      if (!caps.effort) {
        toast(`${harness.name} does not support reasoning effort.`, 'error');
        return true;
      }
      const efforts = effortOptionsFor(harness, currentInfo);
      if (!efforts.length) {
        toast(`${currentInfo?.displayName ?? 'This model'} does not support reasoning effort.`, 'error');
        return true;
      }
      if (!efforts.includes(arg as EffortLevel)) {
        toast(`Efforts: ${efforts.join(', ')}`, 'error');
        return true;
      }
      await setSessionEffort(session.id, arg as EffortLevel, toast);
      return true;
    }
    case 'goal': {
      const sub = rest[0];
      if (!sub || sub === 'status') {
        const g = session.goal;
        toast(g ? `Goal (${g.status}, ${g.iterations}/${g.maxIterations}): ${g.objective}` : 'No goal set. Use /goal <objective>.', 'info');
        store.setPanelTab('goal');
        return true;
      }
      if (['pause', 'resume', 'clear', 'complete'].includes(sub)) {
        await invoke('sessions:goal', { id: session.id, action: sub as 'pause' | 'resume' | 'clear' | 'complete' });
        return true;
      }
      await invoke('sessions:goal', { id: session.id, action: 'set', objective: arg });
      store.setPanelTab('goal');
      return true;
    }
    case 'diff':
      store.setPanelTab('changes');
      return true;
    case 'mcp':
      store.setPanelTab('mcp');
      return true;
    case 'usage':
      store.setPanelTab('usage');
      return true;
    case 'cost':
      toast(`${fmtCost(session.usage.costUsd)} · ${fmtTokens(session.usage.inputTokens)} in / ${fmtTokens(session.usage.outputTokens)} out · ${session.usage.turns} turns`, 'info');
      store.setPanelTab('usage');
      return true;
    case 'compact': {
      const noteId = `local-compact-${session.id}`;
      store.setLocalInfo(session.id, noteId, 'Compacting context…', { pending: true });
      const r = await invoke('sessions:compact', { id: session.id });
      store.setLocalInfo(session.id, noteId, r.ok ? 'Context compacted' : r.detail ?? 'Not supported', { level: r.ok ? 'info' : 'error' });
      return true;
    }
    case 'clear':
      await invoke('sessions:clearTranscript', { id: session.id });
      store.clearTranscriptLocal(session.id);
      return true;
    case 'rename':
      if (arg) await invoke('sessions:rename', { id: session.id, title: arg });
      return true;
    case 'export': {
      const r = await invoke('sessions:export', { id: session.id });
      if (r.path) toast(`Exported to ${r.path}`, 'success');
      return true;
    }
    case 'open':
      if (arg === 'editor') await invoke('app:openInEditor', { path: session.cwd, sessionId: session.id }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error'));
      else if (arg === 'terminal') await invoke('app:openTerminal', { cwd: session.cwd }).then((r) => !r.ok && toast(r.error ?? 'Failed', 'error'));
      else await invoke('app:openPath', { path: session.cwd, sessionId: session.id });
      return true;
    case 'worktree':
      toast(session.worktreeBranch ? `Worktree ${session.cwd} on branch ${session.worktreeBranch}` : 'This session runs directly in the project folder.', 'info');
      return true;
    case 'pr': {
      if (!arg) {
        toast('Usage: /pr <base branch> — pushes this branch and opens a PR into it.', 'error');
        return true;
      }
      // Push + gh pr create can take tens of seconds; show progress here, then let the main
      // process's persistent transcript note carry the outcome (it survives a restart).
      const noteId = `local-pr-${session.id}`;
      store.setLocalInfo(session.id, noteId, `Pushing this branch and opening a PR into ${arg}…`, { pending: true });
      try {
        await invoke('git:pr', { sessionId: session.id, base: arg });
      } catch (e) {
        store.setLocalInfo(session.id, noteId, `Failed to open the PR: ${String((e as Error).message ?? e)}`, { level: 'error' });
        return true;
      }
      store.setLocalInfo(session.id, noteId, null);
      return true;
    }
    case 'merge': {
      const noteId = `local-merge-${session.id}`;
      store.setLocalInfo(session.id, noteId, 'Merging the open PR for this branch…', { pending: true });
      try {
        await invoke('git:merge', { sessionId: session.id, base: arg || undefined });
      } catch (e) {
        store.setLocalInfo(session.id, noteId, `Failed to merge the PR: ${String((e as Error).message ?? e)}`, { level: 'error' });
        return true;
      }
      store.setLocalInfo(session.id, noteId, null);
      return true;
    }
    case 'stop':
      await invoke('sessions:interrupt', { id: session.id });
      return true;
    default:
      return false; // let the harness handle unknown slash commands (e.g. Claude Code's own)
  }
}
