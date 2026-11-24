/** New session dialog: project directory, harness, model, permission mode and worktree isolation (with its branch prefix). */
import React, { useEffect, useId, useRef, useState } from 'react';
import type { AppSettings, EffortLevel, FileAttachment, HarnessId, ImageAttachment, ModelInfo, ModelRef, PermissionMode, SessionConfig } from '../../../shared/types';
import { branchNameFromText, branchPrefixOptions, branchSlug, normalizeBranchPrefix } from '../../../shared/branch-prefix';
import { HARNESSES, PERMISSION_MODE_LABELS, closestPermissionMode, effortOptionsFor, permissionModeHint } from '../../../shared/harness-meta';
import { harnessNeedsSetup, harnessStatus } from '../../../shared/harness-setup';
import { FAST_MODE_COST_WARNING, fastModeSupport } from '../../../shared/fast-mode';
import { rememberedModel, resolveNewSessionDefaults, withFolderSessionDefaults } from '../../../shared/session-defaults';
import { canInvoke, invoke } from '../api';
import { FileAttachmentChips, readAttachments } from '../attachments';
import { rememberEffort, rememberWithoutEffort } from '../sessionActions';
import { useStore } from '../store';
import { Badge, Button, Field, Icon, Kbd, Modal, Spinner, Toggle } from './ui';
import { ModelPicker } from './ModelPicker';
import { FolderPicker } from './FolderPicker';
import { folderChoices } from '../folderChoices';

/** The prefix select's "Custom…" option; never a valid prefix itself (`:` cannot be in a ref). */
const CUSTOM_PREFIX = ':custom';

/** How long typing must pause before the first prompt is sent to the background model for a branch name. */
const NAME_SUGGEST_DELAY_MS = 700;

export function NewSessionDialog() {
  const settings = useStore((s) => s.settings)!;
  const availability = useStore((s) => s.availability);
  const availabilityError = useStore((s) => s.availabilityError);
  const refreshAvailability = useStore((s) => s.refreshAvailability);
  const close = () => useStore.getState().openNewSession(false);
  const setActive = useStore((s) => s.setActive);
  const toast = useStore((s) => s.toast);
  const activeSession = useStore((s) => s.sessions.find((x) => x.id === s.activeId));

  // The folder is chosen before the dialog opens (sidebar button or per-folder +) and can be switched
  // from the header. What the dialog shows is the folder's own remembered choices, falling back field
  // by field to the app-wide defaults (see session-defaults).
  const projectRoot = useStore((s) => s.newSessionRoot) ?? activeSession?.config.projectRoot ?? '';
  const sessions = useStore((s) => s.sessions);
  const initial = resolveNewSessionDefaults(settings, projectRoot);
  const [harness, setHarness] = useState<HarnessId>(initial.harness);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(!!projectRoot);
  const [modelsError, setModelsError] = useState<string | undefined>();
  const [modelRefresh, setModelRefresh] = useState(0);
  // Set by Recheck and consumed by the next discovery, so only that one bypasses main's cache.
  const forceModelRefresh = useRef(false);
  const onboardingOpen = useStore((s) => s.onboardingOpen);
  const previousSetupOpen = useRef(onboardingOpen);
  useEffect(() => {
    if (previousSetupOpen.current && !onboardingOpen) setModelRefresh((v) => v + 1);
    previousSetupOpen.current = onboardingOpen;
  }, [onboardingOpen]);
  const [model, setModel] = useState<ModelRef | undefined>(initial.model);
  const [effort, setEffort] = useState<EffortLevel | ''>(initial.effort);
  const [fastMode, setFastMode] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(initial.permissionMode);
  const [useWorktree, setUseWorktree] = useState(initial.useWorktree);
  // Built-in prefixes, then the user's saved ones; "Custom…" types a new one, saved on start.
  const prefixOptions = branchPrefixOptions(settings.customBranchPrefixes);
  const [prefixChoice, setPrefixChoice] = useState(initial.branchPrefix);
  const [customPrefix, setCustomPrefix] = useState('');
  // Empty means "derive it from the title or first prompt", the way the main process names it.
  const [branchName, setBranchName] = useState('');
  // The folder's local branches; the new branch starts from `base` ('' is the repository's HEAD).
  const [folderBranches, setFolderBranches] = useState<{ current?: string; branches: string[] }>({ branches: [] });
  const [base, setBase] = useState('');
  // The background model's name for the prompt it was asked about; stale once the prompt changes.
  const [suggested, setSuggested] = useState<{ prompt: string; name: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // Undefined until the folder has been probed; worktree isolation is offered only for a repository.
  const [folderIsRepo, setFolderIsRepo] = useState<boolean | undefined>(undefined);
  const [acpAgent, setAcpAgent] = useState(initial.acpAgent ?? settings.acpAgents[0]?.id ?? 'dsh');
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [goal, setGoal] = useState('');
  const [title, setTitle] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [creating, setCreating] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptId = useId();
  const permissionsHintId = useId();
  const fastModeLabelId = useId();

  // Switching folders re-applies that folder's remembered choices; the drafted prompt, goal, title
  // and branch name stay, since they describe the work rather than the folder.
  const appliedRoot = useRef(projectRoot);
  useEffect(() => {
    if (appliedRoot.current === projectRoot) return;
    appliedRoot.current = projectRoot;
    const next = resolveNewSessionDefaults(useStore.getState().settings ?? settings, projectRoot);
    setHarness(next.harness);
    setEffort(next.effort);
    setMode(next.permissionMode);
    setUseWorktree(next.useWorktree);
    setPrefixChoice(next.branchPrefix);
    setCustomPrefix('');
    if (next.acpAgent) setAcpAgent(next.acpAgent);
    setFolderBranches({ branches: [] });
    setBase('');
  }, [projectRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every folder the sidebar knows, once each and most recently worked in first, whichever layout the
  // sidebar is in; the current one is listed even before it has a session.
  const folderList = folderChoices(sessions, settings, projectRoot);
  const chooseRoot = (root: string) => useStore.setState({ newSessionRoot: root });
  const browseRoot = async () => {
    try {
      const r = await invoke('app:pickFolder', { defaultPath: projectRoot || undefined });
      if (r.path) chooseRoot(r.path);
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
    }
  };

  // `git worktree add` needs a repository; without one the toggle would only produce a failed
  // session creation, so the folder is probed before the toggle is offered.
  useEffect(() => {
    if (!projectRoot) {
      setFolderIsRepo(undefined);
      return;
    }
    let cancelled = false;
    setFolderIsRepo(undefined);
    invoke('git:folderIsRepo', { projectRoot })
      // Settled means known either way; only an in-flight probe leaves it undefined.
      .then((r) => !cancelled && setFolderIsRepo(!!r.isRepo))
      .catch(() => !cancelled && setFolderIsRepo(false));
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  useEffect(() => {
    if (folderIsRepo !== true) return;
    let cancelled = false;
    invoke('git:folderBranches', { projectRoot })
      .then((r) => {
        if (cancelled) return;
        setFolderBranches({ current: r?.current, branches: Array.isArray(r?.branches) ? r.branches : [] });
        setBase(r?.current ?? '');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [folderIsRepo, projectRoot]);

  // A picked prefix is the folder's from that moment, whether or not this dialog starts a session.
  // A typed one is saved when its session starts, so a half-typed prefix never lands in settings.
  const choosePrefix = (value: string) => {
    setPrefixChoice(value);
    const current = useStore.getState().settings;
    if (value === CUSTOM_PREFIX || !projectRoot || !current) return;
    void invoke('settings:update', { folderSessionDefaults: withFolderSessionDefaults(current, projectRoot, { branchPrefix: value }) }).catch(() => undefined);
  };

  const descriptor = HARNESSES.find((h) => h.id === harness)!;
  const modes = descriptor.capabilities.permissionModes;
  const modelsAfterStart = descriptor.capabilities.modelSource === 'acp-config';

  useEffect(() => {
    if (!modes.includes(mode)) setMode(closestPermissionMode(harness, mode));
  }, [harness]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setModelsError(undefined);
    setModelsLoading(!!projectRoot);
    setModel(rememberedModel(settings, projectRoot, harness));
    if (!projectRoot) return;
    // Publish the same discovery to existing sessions; opening this dialog must not leave their
    // composer pickers on an older, private snapshot.
    // Main serves a cached catalog for a week; only the Recheck button rediscovers.
    const refresh = forceModelRefresh.current;
    forceModelRefresh.current = false;
    useStore.getState().refreshModelCatalog(harness, { acpAgent, projectRoot, ...(refresh ? { refresh } : {}) })
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setModelsError(r.error);
        if (!rememberedModel(settings, projectRoot, harness)) {
          const def = r.models.find((m) => m.isDefault) ?? r.models[0];
          if (def) setModel({ provider: def.provider, model: def.id });
        }
      })
      .catch((e) => !cancelled && setModelsError(String(e)))
      .finally(() => !cancelled && setModelsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [harness, acpAgent, projectRoot, modelRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedModel = models.find((m) => model && m.id === model.model && m.provider === model.provider);
  const effortOptions = effortOptionsFor(descriptor, selectedModel);
  // Use the selected ref, not catalog metadata: a custom or remembered id may not be listed.
  const fastSupport = fastModeSupport(harness, model, settings.providers);
  useEffect(() => {
    if (!fastSupport.supported) setFastMode(false);
  }, [harness, model?.provider, model?.model, fastSupport.supported]);
  // A model that takes no effort disables the control and submits none; the remembered effort is
  // kept for the next model that has one.
  const noEffort = effortOptions.length === 0;
  // Keep the remembered choice when possible; an incompatible model uses its own default instead
  // of submitting a hidden, unsupported value.
  let selectedEffort: EffortLevel | '' = effort;
  if (effort && !effortOptions.includes(effort)) {
    selectedEffort = selectedModel?.defaultEffort && effortOptions.includes(selectedModel.defaultEffort) ? selectedModel.defaultEffort : '';
  }

  // The toggle state stays the user's preference (it is what gets remembered); a folder without a
  // repository simply cannot act on it. Starting waits for the probe, so a fast click cannot submit
  // the preference before it is known to be usable.
  const isolate = useWorktree && folderIsRepo === true;
  const branchPrefix = prefixChoice === CUSTOM_PREFIX ? normalizeBranchPrefix(customPrefix) : prefixChoice;
  // An unedited name follows the request's intent: a title word for word, as the user wrote it,
  // else the model's reading of the first prompt, with the prompt's own words (filler dropped)
  // standing in until that arrives.
  const promptText = prompt.trim();
  const modelName = !title.trim() && suggested?.prompt === promptText ? suggested.name : undefined;
  const autoSlug = title.trim() ? branchSlug(title) : modelName ?? (promptText ? branchNameFromText(promptText) : undefined);
  const nameSlug = branchName.trim() ? branchSlug(branchName) : autoSlug;
  const branchPreview = branchPrefix ? `${branchPrefix}/${nameSlug ?? '<session-name>'}` : undefined;

  // Only asked while the name is the dialog's to choose, and only once typing pauses.
  const wantsSuggestion = isolate && !branchName.trim() && !title.trim() && promptText.length >= 8;
  useEffect(() => {
    if (!wantsSuggestion || suggested?.prompt === promptText) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSuggesting(true);
      invoke('git:suggestBranchName', { prompt: promptText, model })
        .then((r) => !cancelled && r?.name && setSuggested({ prompt: promptText, name: r.name }))
        .catch(() => undefined)
        .finally(() => !cancelled && setSuggesting(false));
    }, NAME_SUGGEST_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSuggesting(false);
    };
  }, [wantsSuggestion, promptText]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!projectRoot && !modelsLoading && folderIsRepo !== undefined && (!isolate || !!branchPrefix);

  const create = async () => {
    if (modelsLoading) return;
    if (!projectRoot) {
      toast('Choose a project folder first.', 'error');
      return;
    }
    setCreating(true);
    try {
      const config: SessionConfig = {
        harness,
        projectRoot,
        model,
        // undefined inherits the app preference in the main process; null explicitly omits it.
        effort: noEffort ? null : selectedEffort || undefined,
        fastMode: fastSupport.supported && fastMode,
        permissionMode: mode,
        useWorktree: isolate,
        branchPrefix: isolate ? branchPrefix : undefined,
        acpAgent: harness === 'acp' ? acpAgent : undefined,
        appendSystemPrompt: appendSystemPrompt.trim() || undefined,
        maxBudgetUsd: maxBudget ? Number(maxBudget) : undefined
      };
      // Persist before creation so an initial prompt also sees an explicit switch back to the
      // harness default instead of inheriting the previously remembered effort. The folder's own
      // record is what the next dialog on this project opens on; the app-wide values are kept as
      // they were (effort is shared with live session switches, model with cross-harness forks).
      // A model that takes no effort leaves both remembered efforts as they were.
      // A typed prefix joins the saved list (newest first, so a full list drops its oldest entry).
      const newPrefix = isolate && branchPrefix && !prefixOptions.includes(branchPrefix) ? branchPrefix : undefined;
      const remembered: Partial<AppSettings> = {
        ...(newPrefix ? { customBranchPrefixes: [newPrefix, ...(settings.customBranchPrefixes ?? [])] } : {}),
        defaultHarness: harness,
        defaultPermissionMode: mode,
        defaultModelByHarness: { ...settings.defaultModelByHarness, [harness]: model },
        folderSessionDefaults: withFolderSessionDefaults(settings, projectRoot, {
          harness,
          modelByHarness: { ...(settings.folderSessionDefaults?.[projectRoot]?.modelByHarness ?? {}), [harness]: model },
          ...(noEffort ? {} : { effort: selectedEffort || undefined }),
          permissionMode: mode,
          useWorktree,
          // The picker is only shown while isolating; a session without a worktree keeps the folder's prefix.
          ...(isolate && branchPrefix ? { branchPrefix } : {}),
          // Only an ACP session records an agent; another harness must not erase the folder's pick.
          ...(harness === 'acp' ? { acpAgent } : {})
        })
      };
      await (noEffort ? rememberWithoutEffort(remembered) : rememberEffort(selectedEffort || undefined, remembered));
      const meta = await invoke('sessions:create', {
        config,
        title: title.trim() || undefined,
        initialPrompt: prompt.trim() || undefined,
        initialImages: images.length ? images : undefined,
        initialFiles: files.length ? files : undefined,
        goal: harness === 'antigravity' ? undefined : goal.trim() || undefined,
        // The name is sent as previewed, so the branch is the one the dialog showed; the
        // checked-out branch is where an unspecified worktree starts anyway.
        ...(isolate && (branchName.trim() || autoSlug) ? { worktreeName: branchName.trim() || autoSlug } : {}),
        ...(isolate && base && base !== folderBranches.current ? { worktreeBase: base } : {})
      });
      close();
      await setActive(meta.id);
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
    } finally {
      setCreating(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !creating && ready) {
      e.preventDefault();
      void create();
    }
  };

  const addFiles = async (list: Iterable<File>) => {
    const added = await readAttachments(list, (message) => toast(message, 'error'));
    setImages((prev) => [...prev, ...added.images]);
    setFiles((prev) => [...prev, ...added.files]);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    void addFiles(pasted);
  };

  const titleEl = (
    <span className="ns-header">
      <span className="row gap8">
        <Icon name="plus" /> New session
      </span>
      <span className="ns-header-root">
        <FolderPicker value={projectRoot} choices={folderList} onChoose={chooseRoot} onBrowse={canInvoke('app:pickFolder') ? () => void browseRoot() : undefined} />
      </span>
    </span>
  );

  return (
    <Modal
      title={titleEl}
      onClose={close}
      width={860}
      footer={
        <>
          <span className="muted small ns-summary">
            {descriptor.name} · {selectedModel?.displayName ?? model?.model ?? (modelsAfterStart ? 'Agent default' : 'Harness default')}
            {isolate && branchPreview && <> · <code>{branchPreview}</code></>}
          </span>
          <span className="spacer" />
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} disabled={creating || !ready} title="Start from the prompt area with Enter">
            {creating ? <Spinner /> : <Icon name="play" />} Start session <Kbd>↵</Kbd>
          </Button>
        </>
      }
    >
      <div className="ns-toolbar">
        <Button size="sm" variant="ghost" onClick={() => promptRef.current?.focus()}>Jump to first prompt</Button>
      </div>
      <div className="ns-grid">
        <section className="ns-col">
          <div className="field">
            <span className="field-label">Harness</span>
            {availabilityError && <div className="field-hint">Could not check harnesses. <button type="button" className="link-btn" onClick={() => void refreshAvailability()}>Retry</button></div>}
            <div className="harness-cards">
              {HARNESSES.map((h) => {
                const av = availability[h.id];
                const status = harnessStatus(h.id, av);
                return (
                  // Two fixed lines, name over status, each cut with an ellipsis (full text on hover),
                  // so every card has the same shape whatever its name or sign-in state says.
                  <button key={h.id} type="button" className={`harness-card ${harness === h.id ? 'active' : ''}`} aria-pressed={harness === h.id} title={h.tagline} onClick={() => setHarness(h.id)}>
                    <span className="harness-card-name" title={h.name}>{h.name}</span>
                    <span className="harness-card-status">{av ? <Badge tone={status.tone} title={status.label}>{status.label}</Badge> : !availabilityError && <Spinner size={10} />}</span>
                  </button>
                );
              })}
            </div>
            <div className="field-hint">{descriptor.description}</div>
            {availability[harness] && !availability[harness]!.available && (
              <div className="callout warn">
                {availability[harness]!.detail} {availability[harness]!.installHint && <code>{availability[harness]!.installHint}</code>}
              </div>
            )}
          </div>

          {harnessNeedsSetup(harness, availability[harness], { loading: modelsLoading, count: models.length, error: modelsError }) && (
            <>
              <Button size="sm" onClick={() => useStore.getState().openOnboarding(harness)}>Set up / sign in</Button>
              <p className="muted small">Setup opens above this dialog and keeps your prompt and session options.</p>
            </>
          )}
          {harness === 'acp' && (
            <Field label="ACP agent">
              <select value={acpAgent} onChange={(e) => setAcpAgent(e.target.value)}>
                {settings.acpAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <span className="field-hint">{settings.acpAgents.find((a) => a.id === acpAgent)?.description}</span>
            </Field>
          )}
        </section>

        <div className="ns-col-model">
          <section className="ns-col">
            <div className="ns-model-heading">
              <span className="field-label">Model</span>
              <Button size="sm" variant="ghost" icon="refresh" disabled={modelsLoading} onClick={() => { forceModelRefresh.current = true; setModelRefresh((v) => v + 1); void refreshAvailability(); }}>Recheck models and sign-in</Button>
            </div>
            {modelsError && !modelsAfterStart && <p className="muted small ns-model-notice">Any listed suggestions may be fallbacks, not verified account access. Use Set up / sign in to repair the connection.</p>}
            <ModelPicker
              models={models}
              loading={modelsLoading}
              error={modelsError}
              selected={model}
              // The first prompt takes focus on open, so the dialog can be typed into straight away.
              autoFocus={false}
              clearOption={{ label: modelsAfterStart ? 'Agent default (choose after start)' : 'Harness default' }}
              // No onSelectCustom here: a new session starts on a listed model only; an unlisted id is switched in the header afterwards.
              onSelect={(m) => setModel(m ? { provider: m.provider, model: m.id } : undefined)}
            />
          </section>

          <section className="ns-span2 ns-run-options">
            <Field label="Reasoning effort">
              <select value={selectedEffort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')} disabled={!descriptor.capabilities.effort || noEffort} title={noEffort ? `${selectedModel?.displayName ?? 'This model'} does not support reasoning effort` : undefined}>
                <option value="">{noEffort ? 'Not supported' : 'Default'}</option>
                {effortOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <div className="field">
              <label className="field">
                <span className="field-label">Permissions</span>
                <select aria-describedby={permissionsHintId} value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
                  {modes.map((m) => (
                    <option key={m} value={m}>
                      {PERMISSION_MODE_LABELS[m].label}
                    </option>
                  ))}
                </select>
              </label>
              <span id={permissionsHintId} className="field-hint">{permissionModeHint(harness, mode)}</span>
            </div>
            <div className="field ns-fast-mode" role="group" aria-labelledby={fastModeLabelId}>
              <span id={fastModeLabelId} className="field-label">Fast mode</span>
              <div className="ns-fast-mode-control">
                <Toggle checked={fastSupport.supported && fastMode} onChange={setFastMode} disabled={creating || modelsLoading || !fastSupport.supported} ariaLabel="Fast mode" />
              </div>
              <span className="field-hint">{FAST_MODE_COST_WARNING}</span>
              {!fastSupport.supported && <span className="field-hint">{fastSupport.reason ?? 'Fast mode is not supported on this route.'}</span>}
            </div>
            {!descriptor.capabilities.approvals && mode !== 'plan' && <div className="ns-span2 callout warn">This harness cannot ask for approval; the sandbox mode is the only safety boundary.</div>}
          </section>
        </div>

        <section className="ns-span2">
          <div className="field">
            <label className="field-label" htmlFor={promptId}>First prompt (optional)</label>
            {images.length > 0 && (
              <div className="attachments ns-attachments">
                {images.map((im, i) => (
                  <div key={i} className="attachment">
                    <img src={`data:${im.mimeType};base64,${im.data}`} alt={im.name ?? 'image'} />
                    <button type="button" onClick={() => setImages(images.filter((_, j) => j !== i))} aria-label="Remove">
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <FileAttachmentChips files={files} onRemove={(i) => setFiles((current) => current.filter((_, j) => j !== i))} />
            <div className="ns-prompt-box">
              <textarea id={promptId} ref={promptRef} autoFocus rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} placeholder="What should the agent do?" />
              <label className="icon-btn ns-attach" title="Attach files">
                <Icon name="file" size={14} />
                <input type="file" multiple hidden onChange={(e) => { if (e.target.files) void addFiles([...e.target.files]); e.target.value = ''; }} />
              </label>
            </div>
            <span className="field-hint">Paste or attach files and images — they are sent with the first message.</span>
          </div>
          {harness !== 'antigravity' && <Field
            label={<span className="row gap6"><Icon name="target" size={13} /> Goal (optional)</span>}
            hint="A persistent objective. The session keeps continuing until the agent proves it is done or the iteration guard trips. On a harness that has its own /goal command, the objective is handed to that harness instead and the guard does not apply."
          >
            <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Make the test suite pass and open a PR" />
          </Field>}
        </section>

        <section className="ns-span2 ns-workspace">
          <Toggle
            checked={isolate}
            onChange={setUseWorktree}
            disabled={folderIsRepo !== true}
            label={
              <span className="ns-toggle-text">
                <span className="ns-toggle-title">Isolate in a git worktree</span>
                <span className="muted small">
                  {folderIsRepo === false
                    ? 'Unavailable — this folder is not a git repository.'
                    : folderIsRepo === undefined
                      ? 'Checking the folder…'
                      : 'Work on a new branch in .vocs-code/worktrees. Your current checkout stays untouched.'}
                </span>
              </span>
            }
          />
          {isolate && (
            <div className="ns-worktree">
              <div className="ns-worktree-row">
                <div className="field">
                  <span className="field-label">New branch</span>
                  <div className="ns-branch-input">
                    <select className="ns-branch-prefix" aria-label="Branch prefix" value={prefixChoice} onChange={(e) => choosePrefix(e.target.value)}>
                      {prefixOptions.map((p) => (
                        <option key={p} value={p}>
                          {p}/
                        </option>
                      ))}
                      <option value={CUSTOM_PREFIX}>Custom…</option>
                    </select>
                    {prefixChoice === CUSTOM_PREFIX && (
                      <>
                        <input
                          className="ns-branch-custom"
                          aria-label="Custom branch prefix"
                          value={customPrefix}
                          onChange={(e) => setCustomPrefix(e.target.value)}
                          placeholder="prefix"
                          autoFocus
                          // Sized to its text, so the "/" sits right after the prefix like the chip's.
                          style={{ width: `calc(${Math.max(customPrefix.length, 6)}ch + 12px)` }}
                        />
                        <span className="ns-branch-sep" aria-hidden="true">/</span>
                      </>
                    )}
                    <input className="ns-branch-name" aria-label="Branch name" value={branchName} onChange={(e) => setBranchName(e.target.value)} placeholder={autoSlug ?? 'session-name'} />
                  </div>
                </div>
                <Field label="From">
                  <select aria-label="Base branch" value={base} onChange={(e) => setBase(e.target.value)}>
                    {!folderBranches.current && <option value="">Current HEAD</option>}
                    {folderBranches.branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="ns-worktree-hint muted small">
                {branchPreview ? (
                  <>
                    <span className="row gap6">
                      <Icon name="branch" size={12} /> Creates <code>{branchPreview}</code> in <code>.vocs-code/worktrees/{nameSlug ?? '<session-name>'}</code>
                      {suggesting && <span className="row gap6" title="Naming the branch from what the first prompt asks for"><Spinner size={10} /> naming from your prompt…</span>}
                    </span>
                    {prefixChoice === CUSTOM_PREFIX && <span>The new prefix is saved to your prefixes when the session starts.</span>}
                  </>
                ) : customPrefix.trim() ? (
                  'Not a valid branch prefix: use letters, digits, ".", "_" or "-", with "/" between parts.'
                ) : (
                  'Type a prefix, such as bug or team/feat.'
                )}
              </div>
            </div>
          )}
        </section>

        <section className="ns-span2">
          <button type="button" className="link-btn" onClick={() => setAdvanced((v) => !v)}>
            <Icon name={advanced ? 'chevron' : 'chevronRight'} size={12} /> Advanced
          </button>
          {advanced && (
            <div className="advanced">
              <Field label="Session title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto from first prompt" />
              </Field>
              <Field
                label={descriptor.capabilities.systemPrompt ? 'Append to system prompt' : 'Session instructions'}
                hint={descriptor.capabilities.systemPrompt ? undefined : "Sent with the first message; does not replace the harness's own system prompt."}
              >
                <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
              </Field>
              <Field label="Budget cap (USD)" hint="Enforced by the Claude harness; shown as a warning elsewhere.">
                <input type="number" min={0} step={0.5} value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
              </Field>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
