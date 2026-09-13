/** Skills page: browses and manages each harness's global skills (SKILL.md folders). */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SkillHarness, SkillInfo, SkillRootInfo } from '../../../shared/types';
import { invoke } from '../api';
import { basename, relTime } from '../format';
import { installMarkdownHandlers, renderMarkdown } from '../markdown';
import { useStore } from '../store';
import { askConfirm, Badge, Button, Dropdown, EmptyState, Field, Icon, MenuItem, Modal, Spinner } from './ui';

const TONE: Record<SkillHarness, 'amber' | 'green' | 'purple'> = { claude: 'amber', codex: 'green', pi: 'purple' };

export function SkillsView() {
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const [roots, setRoots] = useState<SkillRootInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [harness, setHarness] = useState<SkillHarness | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ content: string; truncated: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const mdBody = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await invoke('skills:list', undefined);
      setRoots(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => {
    for (const r of roots ?? []) {
      const skill = r.skills.find((x) => x.path === selectedPath);
      if (skill) return { root: r, skill };
    }
    return null;
  }, [roots, selectedPath]);

  useEffect(() => {
    setDoc(null);
    if (!selected?.skill.file) return;
    let alive = true;
    void invoke('skills:read', { path: selected.skill.path })
      .then((d) => {
        if (alive) setDoc(d);
      })
      .catch(() => {
        /* preview is best-effort */
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const mdHtml = useMemo(() => (doc ? renderMarkdown(doc.content) : ''), [doc]);
  useEffect(() => {
    if (!mdBody.current || !mdHtml) return;
    return installMarkdownHandlers(mdBody.current, (url) => void invoke('app:openExternal', { url }));
  }, [mdHtml]);

  // Keep the active tab on a real root; default to the first harness that has skills.
  useEffect(() => {
    if (!roots) return;
    if (roots.some((r) => r.harness === harness)) return;
    setHarness(roots.find((r) => r.skills.length > 0)?.harness ?? roots[0]?.harness ?? null);
  }, [roots, harness]);

  const q = query.trim().toLowerCase();
  const activeRoot = useMemo(() => (roots ?? []).find((r) => r.harness === harness), [roots, harness]);
  const activeSkills = useMemo(() => {
    if (!activeRoot) return [];
    if (!q) return activeRoot.skills;
    return activeRoot.skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || basename(s.path).toLowerCase().includes(q));
  }, [activeRoot, q]);
  const total = roots?.reduce((n, r) => n + r.skills.length, 0) ?? 0;

  const switchTab = (h: SkillHarness) => {
    setHarness(h);
    if (harness !== h) setSelectedPath(null);
  };

  const openEditor = async (skill: SkillInfo) => {
    if (!skill.file) return;
    const r = await invoke('skills:openInEditor', { path: skill.file });
    if (!r.ok) toast(r.error ?? 'Could not open the editor', 'error');
  };

  const copyTo = async (skill: SkillInfo, to: SkillHarness, close: () => void) => {
    close();
    const label = roots?.find((r) => r.harness === to)?.label ?? to;
    const r = await invoke('skills:copy', { path: skill.path, toHarness: to });
    if (r.ok) {
      toast(`Copied to ${label}`, 'success');
      setHarness(to);
      await load();
      if (r.path) setSelectedPath(r.path);
    } else {
      toast(r.error ?? 'Copy failed', 'error');
    }
  };

  const remove = async (skill: SkillInfo, close: () => void) => {
    close();
    const ok = await askConfirm({
      title: `Delete skill "${skill.name}"?`,
      body: (
        <>
          The folder <span className="mono">{skill.path}</span> and everything in it is removed. This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete',
      danger: true
    });
    if (!ok) return;
    const r = await invoke('skills:delete', { path: skill.path });
    if (r.ok) {
      toast('Skill deleted', 'success');
      if (selectedPath === skill.path) setSelectedPath(null);
      await load();
    } else {
      toast(r.error ?? 'Delete failed', 'error');
    }
  };

  return (
    <div className="skills">
      <div className="skills-top">
        <div className="skills-title">
          <Button variant="ghost" size="sm" icon="chevronRight" className="rot180" onClick={() => setView('chat')} title="Back" />
          <Icon name="puzzle" size={16} /> Skills
          {roots && <span className="muted small">{total} across {roots.filter((r) => r.skills.length > 0).length} harnesses</span>}
        </div>
        <div className="skills-actions">
          <div className="skills-search">
            <Icon name="search" size={14} />
            <input placeholder="Filter skills" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Button size="sm" icon="refresh" onClick={() => void load()} title="Rescan skill folders">
            Refresh
          </Button>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
            New skill
          </Button>
        </div>
      </div>
      {error && <div className="skills-error">{error}</div>}
      {roots !== null && roots.length > 0 && (
        <div className="skills-tabs">
          {roots.map((r) => (
            <button key={r.harness} type="button" className={`atab ${harness === r.harness ? 'active' : ''}`} onClick={() => switchTab(r.harness)}>
              {r.label}
              <span className="atab-count">{r.skills.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="skills-body">
        <div className="skills-list">
          {roots === null && (
            <div className="skills-loading">
              <Spinner size={16} /> Scanning skill folders…
            </div>
          )}
          {roots !== null && total === 0 && !q && (
            <EmptyState icon="puzzle" title="No skills installed">
              <p>Skills are folders with a <span className="mono">SKILL.md</span> that teach an agent when and how to do something. Each harness loads them from its own home directory.</p>
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                Create your first skill
              </Button>
            </EmptyState>
          )}
          {activeRoot && (
            <div className="skill-root">
              <div className="skill-root-head">
                <span className="skill-root-path mono" title={activeRoot.path}>{activeRoot.display}</span>
                <button type="button" className="skill-reveal" title="Show folder" aria-label="Show folder" onClick={() => void invoke('skills:reveal', { path: activeRoot.path })}>
                  <Icon name="external" size={12} />
                </button>
              </div>
              {activeRoot.skills.length === 0 && !q && <div className="skill-none">{activeRoot.exists ? 'No skills installed.' : 'Directory does not exist yet — it is created with the first skill.'}</div>}
              {activeSkills.map((skill) => (
                <SkillRow
                  key={skill.path}
                  skill={skill}
                  active={skill.path === selectedPath}
                  targets={(roots ?? []).filter((r) => r.harness !== activeRoot.harness)}
                  onSelect={() => setSelectedPath(skill.path)}
                  onEdit={() => void openEditor(skill)}
                  onCopy={(to, close) => void copyTo(skill, to, close)}
                  onDelete={(close) => void remove(skill, close)}
                />
              ))}
              {q && activeSkills.length === 0 && <div className="skill-none">No skills match “{query}”.</div>}
            </div>
          )}
        </div>
        <div className="skills-preview">
          {selected ? (
            <>
              <div className="skills-preview-head">
                <Icon name="puzzle" size={14} />
                <span className="skills-preview-name">{selected.skill.name}</span>
                <Badge tone={TONE[selected.root.harness]}>{selected.root.label}</Badge>
                <span className="spacer" />
                {selected.skill.file && <Button size="sm" variant="ghost" icon="edit" onClick={() => void openEditor(selected.skill)}>Edit</Button>}
                <Button size="sm" variant="ghost" icon="external" onClick={() => void invoke('skills:reveal', { path: selected.skill.path })}>
                  Folder
                </Button>
              </div>
              {selected.skill.broken && (
                <div className="skills-broken">
                  <Icon name="alert" size={13} /> {selected.skill.broken} — this folder is not loaded as a skill.
                </div>
              )}
              {doc && doc.truncated && <div className="skills-truncated">Preview truncated — open in the editor for the full file.</div>}
              {selected.skill.file ? (
                doc ? (
                  <div ref={mdBody} className="md file-md skills-md" dangerouslySetInnerHTML={{ __html: mdHtml }} />
                ) : (
                  <div className="skills-loading">
                    <Spinner size={14} /> Loading SKILL.md…
                  </div>
                )
              ) : (
                <div className="skills-loading">No SKILL.md to preview.</div>
              )}
            </>
          ) : (
            <div className="skills-preview-empty">
              <EmptyState icon="file" title="Select a skill">
                <p>The skill's SKILL.md is previewed here. Edit it in your editor, copy it to another harness's skill folder, or delete it.</p>
              </EmptyState>
            </div>
          )}
        </div>
      </div>
      {creating && (
        <NewSkillDialog
          roots={roots ?? []}
          onClose={() => setCreating(false)}
          onCreated={async (path) => {
            setCreating(false);
            setSelectedPath(path);
            await load();
          }}
        />
      )}
    </div>
  );
}

function SkillRow({
  skill,
  active,
  targets,
  onSelect,
  onEdit,
  onCopy,
  onDelete
}: {
  skill: SkillInfo;
  active: boolean;
  targets: SkillRootInfo[];
  onSelect: () => void;
  onEdit: () => void;
  onCopy: (to: SkillHarness, close: () => void) => void;
  onDelete: (close: () => void) => void;
}) {
  return (
    <div className={`skill-row ${active ? 'active' : ''}`} onClick={onSelect}>
      <div className="skill-main">
        <div className="skill-name">
          <Icon name={skill.broken ? 'alert' : 'puzzle'} size={12} />
          <span>{skill.name}</span>
          {skill.name !== basename(skill.path) && (
            <span className="skill-folder mono" title={skill.path}>
              {basename(skill.path)}
            </span>
          )}
        </div>
        <div className="skill-desc">{skill.description || skill.broken || ''}</div>
      </div>
      <div className="skill-meta">
        {skill.mtimeMs > 0 && <span className="skill-time">{relTime(skill.mtimeMs)}</span>}
        <div onClick={(e) => e.stopPropagation()}>
          <Dropdown align="right" width={210} trigger={() => <button type="button" className="row-menu-btn" aria-label="Skill menu"><Icon name="more" size={18} /></button>}>
            {(close) => (
              <>
                <MenuItem onClick={onEdit} disabled={!skill.file}>Edit SKILL.md</MenuItem>
                <MenuItem onClick={() => void invoke('skills:reveal', { path: skill.path })}>Show folder</MenuItem>
                {targets.map((r) => (
                  <MenuItem key={r.harness} onClick={() => onCopy(r.harness, close)}>Copy to {r.label}</MenuItem>
                ))}
                <MenuItem danger onClick={() => onDelete(close)}>Delete</MenuItem>
              </>
            )}
          </Dropdown>
        </div>
      </div>
    </div>
  );
}

function NewSkillDialog({ roots, onClose, onCreated }: { roots: SkillRootInfo[]; onClose: () => void; onCreated: (path: string) => void }) {
  const [harness, setHarness] = useState<SkillHarness>(roots[0]?.harness ?? 'pi');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await invoke('skills:create', { harness, name, description });
      if (!r.ok) {
        setError(r.error ?? 'Could not create the skill');
        return;
      }
      if (r.path) onCreated(r.path);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New skill"
      width={520}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <div className="skill-form">
        <Field label="Skill folder" hint="Each harness loads skills from its own home directory.">
          <div className="segmented">
            {roots.map((r) => (
              <button key={r.harness} type="button" className={`segment ${harness === r.harness ? 'active' : ''}`} title={r.path} onClick={() => setHarness(r.harness)}>
                {r.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Name" hint="The folder and frontmatter name; lowercase letters, digits, dots, dashes.">
          <input value={name} placeholder="my-skill" autoFocus onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" hint="What the agent reads to decide when to use the skill.">
          <textarea rows={3} value={description} placeholder="Use when the user asks to…" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error && <div className="skills-error">{error}</div>}
      </div>
    </Modal>
  );
}
