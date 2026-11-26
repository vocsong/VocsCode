/** Interactive permission approval and structured question cards rendered inside transcripts. */
import React, { useEffect, useId, useRef, useState } from 'react';
import { validateQuestionResponse } from '../../../../shared/question-response';
import type { ApprovalDecision, ApprovalRequest, FileChange, TranscriptItem } from '../../../../shared/types';
import { invoke } from '../../api';
import { useCanInvoke } from '../../capabilities';
import { fmtStampFull } from '../../format';
import { builderIndexOf } from '../../mission';
import { useStore } from '../../store';
import { DiffView } from '../DiffView';
import { HarnessPill } from '../SessionTitle';
import { Badge, Button, Icon } from '../ui';
import { Stamp } from './shared';

export function ApprovalCard({ item, sessionId }: { item: Extract<TranscriptItem, { kind: 'approval' }>; sessionId: string }) {
  const req = item.request;
  // A transport that would refuse the answer gets a read-only card.
  const canRespond = useCanInvoke('approvals:respond');
  const toast = useStore((s) => s.toast);
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multiAnswers, setMultiAnswers] = useState<Record<string, string[]>>({});
  const [editedCommand, setEditedCommand] = useState<string | null>(null);
  const [responseState, setResponseState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => setValidationError(null), [answers, multiAnswers, note]);
  const responding = useRef(false);
  const fieldId = useId();
  const decided = !!item.decision;
  const locked = decided || !canRespond || responseState !== 'idle';
  const questionComment = req.kind === 'question' && req.supportsQuestionComment !== false;
  const hasMultiAnswer = Object.values(multiAnswers).some((selected) => selected.length > 0);
  const emptyQuestion = questionComment && !Object.values(answers).some((answer) => answer.trim()) && !hasMultiAnswer && !note.trim();
  const noteLabel = req.kind === 'question' ? 'Additional context (optional)' : 'Note for the agent (sent with Deny only)';
  const decisionKind = req.options.find((o) => o.id === item.decision?.optionId)?.kind ?? item.decision?.optionId ?? '';
  // Mission mode: a Builder's request goes to its Lead first. The Lead's copy of the card answers the
  // Builder's own request, so the response names the session that asked, not the one being viewed.
  const route = req.mission;
  const target = route && req.sessionId ? req.sessionId : sessionId;
  const askingBuilder = useStore((s) => (route && req.sessionId && req.sessionId !== sessionId ? builderIndexOf(req.sessionId, s.missionViews, s.sessions) : undefined));
  const recommendation = route?.recommendation;
  const respond = (optionId: string) => {
    if (locked || responding.current) return;
    const option = req.options.find((o) => o.id === optionId);
    const sendsNote = questionComment || (req.kind !== 'question' && (option?.kind === 'deny' || option?.kind === 'deny_always'));
    const decision: ApprovalDecision = { optionId, note: sendsNote ? note.trim() || undefined : undefined };
    if (req.questions?.length) {
      decision.answers = answers;
      if (req.questions.some((q) => q.multiSelect)) decision.multiAnswers = multiAnswers;
    }
    if (editedCommand !== null && editedCommand !== req.command && req.input && typeof req.input === 'object') decision.updatedInput = { ...(req.input as Record<string, unknown>), command: editedCommand };
    try {
      validateQuestionResponse(req, decision);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
      return;
    }
    responding.current = true;
    setResponseState('sending');
    void invoke('approvals:respond', { sessionId: target, requestId: req.id, decision }).then(() => {
      // Keep the draft locked until the persisted decision arrives, not just until IPC resolves.
      setResponseState('sent');
    }).catch((e: unknown) => {
      responding.current = false;
      setResponseState('idle');
      toast(`Approval could not be sent: ${e instanceof Error ? e.message : String(e)}`, 'error');
    });
  };
  return (
    <div className={`approval ${decided ? 'decided' : 'pending'}`}>
      <div className="approval-head">
        <span className="approval-glyph"><Icon name="shield" size={14} /></span>
        <span className="approval-heading">
          <span className="approval-title">{req.title}</span>
          {req.description && <span className="approval-desc">{req.description}</span>}
        </span>
        <Stamp ts={item.ts} className="approval-time" detail={item.decidedAt ? `answered ${fmtStampFull(item.decidedAt)}` : undefined} />
        <HarnessPill harness={req.harness} />
        {decided && <Badge tone={/deny|reject|cancel/.test(decisionKind) ? 'red' : 'green'}>{labelFor(req, item.decision!.optionId)}</Badge>}
      </div>
      {(route || item.decidedBy === 'lead') && (
        <div className="approval-mission" data-status={route?.status}>
          <Icon name="flag" size={12} />
          {askingBuilder ? <span className="approval-mission-who">Builder {askingBuilder}</span> : null}
          {decided ? (
            <span>{item.decidedBy === 'lead' ? 'Answered by the Lead' : 'Answered by you'}</span>
          ) : route?.status === 'with_lead' ? (
            <span>With the Lead — it answers first; you can still decide here.</span>
          ) : (
            <span>Needs you{route?.reason ? `: ${route.reason}` : ''}</span>
          )}
        </div>
      )}
      {route && recommendation && (
        <div className="approval-recommendation" data-verdict={recommendation.verdict}>
          <span className="approval-note-label">The Lead recommends: {recommendation.verdict === 'allow' ? 'Allow' : 'Deny'}</span>
          {recommendation.note && <div>{recommendation.note}</div>}
        </div>
      )}
      {req.command !== undefined && (
        decided ? (
          <pre className="approval-cmd mono">{req.command}</pre>
        ) : (
          <textarea className="approval-cmd mono editable" aria-label="Command" disabled={locked} value={editedCommand ?? req.command} onChange={(e) => setEditedCommand(e.target.value)} rows={Math.min(6, (req.command.match(/\n/g)?.length ?? 0) + 1)} spellCheck={false} />
        )
      )}
      {req.cwd && req.command !== undefined && <div className="approval-cwd muted small">in {req.cwd}</div>}
      {req.changes?.length ? <ChangesPreview changes={req.changes} /> : null}
      {req.questions?.map((q, qi) => {
        const questionId = `${fieldId}-question-${qi}`;
        const skipped = /deny|reject|cancel/.test(decisionKind);
        const savedAnswer = skipped ? undefined : item.decision?.answers?.[q.id]?.trim() || undefined;
        const savedMulti = skipped ? undefined : item.decision?.multiAnswers?.[q.id]?.filter(Boolean);
        const savedOption = !q.secret && !q.multiSelect && q.options?.find((o) => o.label === savedAnswer);
        const savedMultiOptions = !q.secret && q.multiSelect && savedMulti?.length
          ? savedMulti.map((label) => ({ label, description: q.options?.find((o) => o.label === label)?.description }))
          : [];
        const hasSaved = Boolean(savedAnswer || savedMulti?.length);
        return (
          <div key={q.id} className="approval-question" role="group" aria-labelledby={questionId}>
            {q.header && <div className="approval-qhead">{q.header}</div>}
            <div className="approval-qtext" id={questionId}>{q.question}</div>
            {decided ? (
              hasSaved ? (
                q.secret ? (
                  <div className="approval-answer"><span>Answer hidden</span></div>
                ) : q.multiSelect ? (
                  <div className="approval-answer">
                    {savedMultiOptions.map((opt) => (
                      <div key={opt.label} className="approval-answer-item">
                        <span>{opt.label}</span>
                        {opt.description && <span className="approval-choice-desc">{opt.description}</span>}
                      </div>
                    ))}
                    {savedAnswer && <div className="approval-answer-item"><span>{savedAnswer}</span></div>}
                  </div>
                ) : (
                  <div className="approval-answer">
                    <span>{savedAnswer}</span>
                    {savedOption && savedOption.description && <span className="approval-choice-desc">{savedOption.description}</span>}
                  </div>
                )
              ) : <div className="muted small">No answer provided</div>
            ) : (
              <>
                {q.multiSelect && q.options?.length ? <div className="approval-qhint muted small">Select one or more</div> : null}
                {q.options?.length ? (
                  <div className="approval-qopts">
                    {q.options.map((o, oi) => {
                      const descriptionId = `${questionId}-option-${oi}`;
                      const selected = q.multiSelect ? (multiAnswers[q.id]?.includes(o.label) ?? false) : answers[q.id] === o.label;
                      return (
                        <button
                          key={o.label}
                          type="button"
                          className={`approval-choice ${selected ? 'active' : ''}`}
                          disabled={locked}
                          onClick={() => {
                            if (q.multiSelect) {
                              const prev = multiAnswers[q.id] ?? [];
                              const next = prev.includes(o.label) ? prev.filter((label) => label !== o.label) : [...prev, o.label];
                              setMultiAnswers(next.length ? { ...multiAnswers, [q.id]: next } : Object.fromEntries(Object.entries(multiAnswers).filter(([id]) => id !== q.id)));
                            } else {
                              setAnswers(answers[q.id] === o.label ? Object.fromEntries(Object.entries(answers).filter(([id]) => id !== q.id)) : { ...answers, [q.id]: o.label });
                            }
                          }}
                          aria-label={o.label}
                          aria-pressed={selected}
                          aria-describedby={o.description ? descriptionId : undefined}
                        >
                          <span className="approval-choice-label">{o.label}{selected && <Icon name="check" size={14} />}</span>
                          {o.description && <span className="approval-choice-desc" id={descriptionId}>{o.description}</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {(q.allowOther || !q.options?.length) && (
                  <label className="approval-field">
                    <span>Type an answer</span>
                    <input
                      type={q.secret ? 'password' : 'text'}
                      placeholder="Type an answer"
                      aria-describedby={questionId}
                      disabled={locked}
                      value={q.multiSelect ? (answers[q.id] ?? '') : (answers[q.id] && !q.options?.some((o) => o.label === answers[q.id]) ? answers[q.id] : '')}
                      onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                    />
                  </label>
                )}
              </>
            )}
          </div>
        );
      })}
      {decided && item.decision?.note && (
        <div className="approval-saved-note">
          <div className="approval-note-label">{req.kind === 'question' ? 'Additional context' : 'Note for the agent'}</div>
          <div>{item.decision.note}</div>
        </div>
      )}
      {!decided && (req.kind !== 'question' || questionComment) && (
        <label className="approval-field">
          <span>{noteLabel}</span>
          <textarea className="approval-note" rows={2} disabled={locked} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      {!decided && validationError && <div className="callout warn small" role="alert">{validationError}</div>}
      {!decided && emptyQuestion && <div className="muted small" id={`${fieldId}-response-hint`}>Choose an option, type an answer, or add context to continue.</div>}
      {!decided && canRespond && (
        <div className="approval-actions">
          {req.options.map((o) => (
            <Button key={o.id} className={`approval-opt opt-${o.kind}`} variant={o.kind === 'allow' ? 'primary' : o.kind === 'allow_session' || o.kind === 'allow_always' ? 'default' : 'ghost'} size="sm" disabled={locked || (emptyQuestion && o.kind === 'allow')} aria-describedby={emptyQuestion && o.kind === 'allow' ? `${fieldId}-response-hint` : undefined} onClick={() => respond(o.id)} title={o.description}>
              {o.label}
            </Button>
          ))}
          {responseState !== 'idle' && <span className="muted small" role="status">{responseState === 'sending' ? 'Sending response…' : 'Response sent'}</span>}
        </div>
      )}
    </div>
  );
}

function labelFor(req: ApprovalRequest, optionId: string): string {
  return req.options.find((o) => o.id === optionId)?.label ?? optionId;
}

function ChangesPreview({ changes }: { changes: FileChange[] }) {
  const withDiff = changes.filter((c) => c.diff);
  return (
    <div className="approval-changes">
      <div className="approval-files">
        {changes.map((c) => (
          <span key={c.path} className={`file-chip kind-${c.kind}`}>
            {c.kind === 'add' ? '+' : c.kind === 'delete' ? '−' : '~'} {c.path}
          </span>
        ))}
      </div>
      {withDiff.length > 0 && <DiffView diff={withDiff.map((c) => c.diff!).join('\n')} compact />}
    </div>
  );
}
