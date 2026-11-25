/** Codex model catalog mapping, paginated `model/list` reader, and one-shot pre-session model discovery. */
import { isEffortLevel } from '../../shared/harness-meta';
import type { ModelInfo } from '../../shared/types';
import { findPricing } from '../models/static-models';
import { withTimeout } from '../util/async';
import { JsonRpcStdioClient } from './jsonrpc';
import { spawnTool } from './spawn';

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  isDefault: boolean;
  serviceTiers?: { id: string }[];
  additionalSpeedTiers?: string[];
}

export function codexModelSpeedTiers(model: CodexModel): string[] | undefined {
  return model.serviceTiers?.map((tier) => tier.id) ?? model.additionalSpeedTiers;
}

export function codexModelToInfo(m: CodexModel, provider = 'openai'): ModelInfo {
  const pricing = findPricing('openai', m.model);
  // Codex advertises levels the app does not model (ultra, persistent); only ours may enter the shared effort state.
  const efforts = (m.supportedReasoningEfforts ?? []).map((o) => o.reasoningEffort).filter(isEffortLevel);
  return {
    id: m.model,
    provider,
    displayName: m.displayName || m.model,
    description: m.description,
    supportsImages: (m.inputModalities ?? []).includes('image'),
    supportsReasoning: true,
    supportedEfforts: efforts.length ? efforts : undefined,
    defaultEffort: isEffortLevel(m.defaultReasoningEffort) ? m.defaultReasoningEffort : undefined,
    isDefault: m.isDefault,
    pricing
  };
}

/** Read every visible-model page, within one deadline; never serve a silently truncated catalog. */
export async function readCodexModelCatalog(rpc: JsonRpcStdioClient, observe?: (model: CodexModel) => void): Promise<ModelInfo[]> {
  const deadline = Date.now() + 20_000;
  const seen = new Set<string>();
  const models = new Map<string, ModelInfo>();
  let cursor: string | undefined;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('model/list timed out after 20000ms');
    const page = await withTimeout(
      rpc.request<{ data: CodexModel[]; nextCursor?: string | null }>('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }),
      remaining,
      'model/list'
    );
    for (const model of page.data) {
      observe?.(model);
      models.set(model.model, codexModelToInfo(model));
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) {
      if (seen.has(cursor)) throw new Error('model/list repeated a pagination cursor');
      seen.add(cursor);
    }
  } while (cursor);
  return [...models.values()];
}

/**
 * One-shot model listing without a session: spawn app-server, initialize, model/list, exit.
 */
export async function listCodexModels(codexPath: string, observe?: (model: CodexModel) => void): Promise<ModelInfo[]> {
  const child = spawnTool(codexPath, ['app-server']);
  const rpc = new JsonRpcStdioClient(child);
  try {
    await withTimeout(rpc.request('initialize', { clientInfo: { name: 'vocs-code', title: 'Vocs Code', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } }), 20_000, 'initialize');
    return await readCodexModelCatalog(rpc, observe);
  } finally {
    await rpc.close();
  }
}
