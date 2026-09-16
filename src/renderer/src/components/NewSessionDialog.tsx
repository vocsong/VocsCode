/** New session dialog: project directory, harness, model, permission mode and worktree isolation. */
import React, { useEffect, useRef, useState } from 'react';
import type { EffortLevel, HarnessId, ImageAttachment, ModelInfo, ModelRef, PermissionMode, SessionConfig } from '../../../shared/types';
import { EFFORT_LEVELS, HARNESSES, PERMISSION_MODE_LABELS } from '../../../shared/harness-meta';
import { rememberedModel, resolveNewSessionDefaults, withFolderSessionDefaults } from '../../../shared/session-defaults';
import { invoke } from '../api';
import { rememberEffort } from '../sessionActions';
import { useStore } from '../store';
import { Badge, Button, Field, Icon, Kbd, Modal, Spinner, Toggle } from './ui';
import { ModelPicker } from './ModelPicker';
import { fileToAttachment } from './Composer';

export function NewSessionDialog() {
  const settings = useStore((s) => s.settings)!;
  const availability = useStore((s) => s.availability);
  const availabilityError = useStore((s) => s.availabilityError);
  const refreshAvailability = useStore((s) => s.refreshAvailability);
  const close = () => useStore.getState().openNewSession(false);
  const setActive = useStore((s) => s.setActive);
  const toast = useStore((s) => s.toast);
  const activeSession = useStore((s) => s.sessions.find((x) => x.id === s.activeId));

  // The folder is chosen before the dialog opens (sidebar button or per-folder +); the dialog only
  // configures harness, model and options for that folder. What it opens on is the folder's own
  // remembered choices, falling back field by field to the app-wide defaults (see session-defaults).
  const projectRoot = useStore((s) => s.newSessionRoot) ?? activeSession?.config.projectRoot ?? '';
  const initial = resolveNewSessionDefaults(settings, projectRoot);
  const [harness, setHarness] = useState<HarnessId>(initial.harness);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(!!projectRoot);
  const [modelsError, setModelsError] = useState<string | undefined>();
  const [model, setModel] = useState<ModelRef | undefined>(initial.model);
  const [effort, setEffort] = useState<EffortLevel | ''>(initial.effort);
  const [mode, setMode] = useState<PermissionMode>(initial.permissionMode);
  const [useWorktree, setUseWorktree] = useState(initial.useWorktree);
  // Undefined until the folder has been probed; worktree isolation is offered only for a repository.
  const [folderIsRepo, setFolderIsRepo] = useState<boolean | undefined>(undefined);
  const [acpAgent, setAcpAgent] = useState(initial.acpAgent ?? settings.acpAgents[0]?.id ?? 'dsh');
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [goal, setGoal] = useState('');
  const [title, setTitle] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [creating, setCreating] = useState(false);

  // Focus the first-prompt textarea so typing can start immediately.
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  // The model column keeps the harness column's height; the model list scrolls inside it.
  const harnessColRef = useRef<HTMLElement>(null);
  const modelColRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const left = harnessColRef.current;
    const right = modelColRef.current;
    if (!left || !right) return;
    const apply = () => {
      right.style.height = `${left.offsetHeight}px`;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(left);
    return () => ro.disconnect();
  }, [harness, acpAgent]);

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

  const descriptor = HARNESSES.find((h) => h.id === harness)!;
  const modes = descriptor.capabilities.permissionModes;

  useEffect(() => {
    if (!modes.includes(mode)) setMode(modes.includes('ask') ? 'ask' : modes[0]);
  }, [harness]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setModelsError(undefined);
    setModelsLoading(!!projectRoot);
    setModel(rememberedModel(settings, projectRoot, harness));
    if (!projectRoot) return;
    invoke('harness:models', { harness, acpAgent, projectRoot })
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
  }, [harness, acpAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedModel = models.find((m) => model && m.id === model.model && m.provider === model.provider);
  const supportedEfforts = selectedModel?.supportedEfforts;
  const effortOptions = supportedEfforts?.length ? supportedEfforts : [...EFFORT_LEVELS];
  // Keep the remembered choice when possible; an incompatible model uses its own default instead
  // of submitting a hidden, unsupported value.
  let selectedEffort: EffortLevel | '' = effort;
  if (effort && supportedEfforts?.length && !supportedEfforts.includes(effort)) {
    selectedEffort = selectedModel?.defaultEffort && supportedEfforts.includes(selectedModel.defaultEffort) ? selectedModel.defaultEffort : '';
  }

  // The toggle state stays the user's preference (it is what gets remembered); a folder without a
  // repository simply cannot act on it. Starting waits for the probe, so a fast click cannot submit
  // the preference before it is known to be usable.
  const isolate = useWorktree && folderIsRepo === true;
  const ready = !!projectRoot && !modelsLoading && folderIsRepo !== undefined;

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
        effort: selectedEffort || undefined,
        permissionMode: mode,
        useWorktree: isolate,
        acpAgent: harness === 'acp' ? acpAgent : undefined,
        appendSystemPrompt: appendSystemPrompt.trim() || undefined,
        maxBudgetUsd: maxBudget ? Number(maxBudget) : undefined
      };
      // Persist before creation so an initial prompt also sees an explicit switch back to the
      // harness default instead of inheriting the previously remembered effort. The folder's own
      // record is what the next dialog on this project opens on; the app-wide values are kept as
      // they were (effort is shared with live session switches, model with cross-harness forks).
      await rememberEffort(selectedEffort || undefined, {
        defaultHarness: harness,
        defaultPermissionMode: mode,
        defaultModelByHarness: { ...settings.defaultModelByHarness, [harness]: model },
        folderSessionDefaults: withFolderSessionDefaults(settings, projectRoot, {
          harness,
          modelByHarness: { ...(settings.folderSessionDefaults?.[projectRoot]?.modelByHarness ?? {}), [harness]: model },
          effort: selectedEffort || undefined,
          permissionMode: mode,
          useWorktree,
          // Only an ACP session records an agent; another harness must not erase the folder's pick.
          ...(harness === 'acp' ? { acpAgent } : {})
        })
      });
      const meta = await invoke('sessions:create', { config, title: title.trim() || undefined, initialPrompt: prompt.trim() || undefined, initialImages: images.length ? images : undefined, goal: goal.trim() || undefined });
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

  // Same image handling as the chat composer: pasted or picked screenshots ride along with the first prompt.
  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const imgs = await Promise.all(files.map(fileToAttachment));
    setImages((prev) => [...prev, ...imgs]);
  };

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const imgs = await Promise.all([...list].filter((f) => f.type.startsWith('image/')).map(fileToAttachment));
    setImages((prev) => [...prev, ...imgs]);
  };

  const titleEl = (
    <span className="ns-header">
      <span className="row gap8">
        <Icon name="plus" /> New session
      </span>
      <span className="ns-header-root row gap6" title={projectRoot}>
        <Icon name="folder" size={13} />
        <span className="ns-root">{projectRoot || 'No folder selected'}</span>
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
          <span className="muted small">{descriptor.tagline}</span>
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
      <div className="ns-grid">
        <section className="ns-col" ref={harnessColRef}>
          <Field label="Harness">
            <div className="harness-cards">
              {HARNESSES.map((h) => {
                const av = availability[h.id];
                return (
                  <button key={h.id} type="button" className={`harness-card ${harness === h.id ? 'active' : ''}`} onClick={() => setHarness(h.id)}>
                    <div className="harness-card-top">
                      <span className="harness-card-name">{h.name}</span>
                      {av ? av.available ? <Badge tone={av.authenticated === false ? 'amber' : 'green'}>{av.authenticated === false ? 'not logged in' : av.version ? av.version.replace(/[^\d.]+.*$/, '') || 'ready' : 'ready'}</Badge> : <Badge tone="red">missing</Badge> : availabilityError ? (
                        <span
                          className="link-btn"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => { e.stopPropagation(); void refreshAvailability(); }}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void refreshAvailability(); } }}
                        >
                          could not check — retry
                        </span>
                      ) : <Spinner size={10} />}
                    </div>
                    <div className="harness-card-tag">{h.tagline}</div>
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
          </Field>

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

        <section className="ns-col ns-col-model" ref={modelColRef}>
          <Field label={<span className="row gap6">Model {modelsLoading && <Spinner size={11} />}</span>} hint={modelsError}>
            <ModelPicker
              models={models}
              loading={modelsLoading}
              error={modelsError}
              selected={model}
              clearOption={{ label: harness === 'acp' ? 'Agent default (choose after start)' : 'Harness default' }}
              // No onSelectCustom here: a new session starts on a listed model only; an unlisted id is switched in the header afterwards.
              onSelect={(m) => setModel(m ? { provider: m.provider, model: m.id } : undefined)}
            />
          </Field>
          <div className="row gap12">
            <Field label="Reasoning effort">
              <select value={selectedEffort} onChange={(e) => setEffort(e.target.value as EffortLevel | '')} disabled={!descriptor.capabilities.effort}>
                <option value="">Default</option>
                {effortOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Permissions">
              <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
                {modes.map((m) => (
                  <option key={m} value={m}>
                    {PERMISSION_MODE_LABELS[m].label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="field-hint">{PERMISSION_MODE_LABELS[mode].description}</div>
          {!descriptor.capabilities.approvals && mode !== 'plan' && <div className="callout warn">This harness cannot ask for approval; the sandbox mode is the only safety boundary.</div>}

          <Toggle
            checked={isolate}
            onChange={setUseWorktree}
            disabled={folderIsRepo !== true}
            label={
              <span>
                Isolate in a git worktree{' '}
                <span className="muted">
                  {folderIsRepo === false ? '(unavailable — this folder is not a git repository)' : folderIsRepo === undefined ? '(checking the folder…)' : '(new branch under .vocs-code/worktrees)'}
                </span>
              </span>
            }
          />
        </section>

        <section className="ns-span2">
          <div className="field">
            <span className="field-label">First prompt (optional)</span>
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
            <div className="ns-prompt-box">
              <textarea ref={promptRef} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} placeholder="What should the agent do?" />
              <label className="icon-btn ns-attach" title="Attach image">
                <Icon name="image" size={14} />
                <input type="file" accept="image/*" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
              </label>
            </div>
            <span className="field-hint">Paste a screenshot or attach one with the button — it is sent with the first message.</span>
          </div>
          <Field
            label={<span className="row gap6"><Icon name="target" size={13} /> Goal (optional)</span>}
            hint="A persistent objective. The session keeps continuing until the agent proves it is done or the iteration guard trips. On a harness that has its own /goal command, the objective is handed to that harness instead and the guard does not apply."
          >
            <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Make the test suite pass and open a PR" />
          </Field>

          <button type="button" className="link-btn" onClick={() => setAdvanced((v) => !v)}>
            <Icon name={advanced ? 'chevron' : 'chevronRight'} size={12} /> Advanced
          </button>
          {advanced && (
            <div className="advanced">
              <Field label="Session title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto from first prompt" />
              </Field>
              <Field label="Append to system prompt">
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
