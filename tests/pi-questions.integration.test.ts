/** Real Pi RPC question-tool dispatch, with an offline model and no provider credentials. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PiOfflineRunner, piIntegrationPaths, type PiEvent } from './pi-offline-runner';

const enabled = process.env.VOCS_CODE_PI_INTEGRATION === '1';
const marker = 'VCODE_QUESTION::';
const input = { question: 'Which environment?', header: 'Deployment', options: [{ label: 'staging', description: 'Preview without affecting production.' }, { label: 'production', description: 'Update the public service.' }] };
const questionRequest = (event: PiEvent) => event.type === 'extension_ui_request' && event.method === 'select' && event.title?.startsWith(marker);

const text = (event: PiEvent) => (event.result?.content ?? []).map((part: PiEvent) => part.text ?? '').join('\n');

describe.skipIf(!enabled)('Pi structured questions over the real runtime', () => {
  let root: string;
  let runner: PiOfflineRunner;
  beforeAll(() => { piIntegrationPaths(); });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'vocs-pi-questions-'));
    const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
    await fs.mkdir(cwd); await fs.mkdir(agentDir);
    await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
    runner = new PiOfflineRunner({ cwd, agentDir });
    await runner.ready();
  });
  afterEach(async () => {
    await runner?.close();
    if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('advertises a callable structured question tool with guidance instead of relying on model prose', () => {
    const tools = runner.events.filter((event) => event.type === 'extension_ui_request' && event.message?.startsWith('PI_FIXTURE_TOOLS::'))
      .flatMap((event) => JSON.parse(event.message.slice('PI_FIXTURE_TOOLS::'.length)).tools as PiEvent[]);
    const question = tools.find((tool) => tool.name === 'ask_user');
    expect(question).toBeDefined();
    expect(question!.parameters.properties.options.items.properties.description).toBeDefined();
    expect(question!.promptGuidelines.join(' ')).toContain('one question at a time');
  });

  it.each([
    { label: 'selection and context', reply: { cancelled: false, answer: 'staging', comment: 'Wait for my release window.' } },
    { label: 'typed answer and context', reply: { cancelled: false, answer: 'a disposable preview', comment: 'Delete it after review.' } },
    { label: 'skip and context', reply: { cancelled: true, comment: 'I need to confirm with the team.' } },
  ])('returns $label to the model without losing either value', async ({ reply }) => {
    const from = runner.events.length;
    await runner.request('prompt', { message: JSON.stringify({ calls: [{ id: 'question1', name: 'ask_user', arguments: input }] }) });
    const request = await runner.waitFor(questionRequest, from);
    expect(JSON.parse(request.title.slice(marker.length))).toMatchObject({ version: 1, nonce: 'offline-process', toolCallId: 'question1', ...input });
    runner.send({ type: 'extension_ui_response', id: request.id, value: JSON.stringify(reply) });
    await runner.waitFor((event) => event.type === 'agent_settled', from);
    const events = runner.events.slice(from);
    const ended = events.filter((event) => event.type === 'tool_execution_end');
    expect(ended).toHaveLength(1);
    expect(ended[0].isError).toBe(false);
    expect(ended[0].result.details).toMatchObject({ question: input.question, ...reply });
    expect(text(ended[0])).toContain(reply.comment);
    if ('answer' in reply) expect(text(ended[0])).toContain(reply.answer);
    else expect(ended[0].result.details.answer).toBeUndefined();
    const final = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').at(-1);
    expect(final?.message.content).toEqual([{ type: 'text', text: `QUESTION_SEEN:${text(ended[0])}` }]);
    expect(events.filter((event) => event.type === 'extension_error')).toEqual([]);
    expect(events.filter((event) => event.type === 'agent_settled')).toHaveLength(1);
  });

  it('does not turn a question answer into a tool-permission grant', async () => {
    await runner.close();
    runner = new PiOfflineRunner({ cwd: path.join(root, 'workspace'), agentDir: path.join(root, 'agent'), mode: 'ask' });
    await runner.ready();
    const from = runner.events.length;
    await runner.request('prompt', { message: JSON.stringify({ calls: [{ id: 'question1', name: 'ask_user', arguments: { question: 'Choose a label', options: [{ label: 'Allow for session' }, { label: 'Deny' }] } }] }) });
    const question = await runner.waitFor(questionRequest, from);
    runner.send({ type: 'extension_ui_response', id: question.id, value: JSON.stringify({ cancelled: false, answer: 'Allow for session' }) });
    await runner.waitFor((event) => event.type === 'agent_settled', from);
    const target = path.join(root, 'workspace', 'must-not-exist.txt');
    const events = await runner.prompt([{ id: 'write1', name: 'write', arguments: { path: target, content: 'forbidden' } }]);
    const approval = events.filter((event) => event.type === 'extension_ui_request' && event.title?.startsWith('VCODE_APPROVAL::'));
    expect(approval).toHaveLength(1);
    const ended = events.filter((event) => event.type === 'tool_execution_end');
    expect(ended).toHaveLength(1);
    expect(ended[0].isError).toBe(true);
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a pending question on abort, ignores its stale reply and accepts a later turn', async () => {
    const from = runner.events.length;
    await runner.request('prompt', { message: JSON.stringify({ calls: [{ id: 'question1', name: 'ask_user', arguments: input }] }) });
    const request = await runner.waitFor(questionRequest, from);
    await runner.request('abort');
    await runner.waitFor((event) => event.type === 'agent_settled', from);
    runner.send({ type: 'extension_ui_response', id: request.id, value: JSON.stringify({ cancelled: false, answer: 'production', comment: 'Stale reply' }) });
    const next = await runner.prompt([]);
    expect(next.filter((event) => event.type === 'tool_execution_end')).toEqual([]);
    expect(next.filter((event) => event.type === 'extension_error')).toEqual([]);
    expect(next.filter((event) => event.type === 'agent_settled')).toHaveLength(1);
    const final = next.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').at(-1);
    expect(final?.message.content).toEqual([{ type: 'text', text: 'COMPAT_OK' }]);
  });
});
