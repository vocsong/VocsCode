import { isEffortLevel } from '../../shared/harness-meta';
import type { ModelInfo } from '../../shared/types';

/** An ACP session config option (`session/new` → `configOptions`), as the adapter reads it. */
export interface ConfigOptionLike {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: 'select' | 'boolean';
  currentValue: string | boolean;
  options?: { value?: string; name: string; description?: string | null; group?: string; options?: { value: string; name: string; description?: string | null; group?: string }[] }[];
}

export function flattenSelect(opt: ConfigOptionLike): { value: string; name: string; description?: string | null; group?: string }[] {
  const out: { value: string; name: string; description?: string | null; group?: string }[] = [];
  for (const o of opt.options ?? []) {
    if (Array.isArray(o.options)) for (const g of o.options) out.push({ ...g, group: g.group ?? o.group });
    else if (typeof o.value === 'string') out.push({ value: o.value, name: o.name, description: o.description, group: o.group });
  }
  return out;
}

/** dsh-style agents advertise model choices as JSON `[provider, model]` tuples; decode them. */
export function decodeAcpModelValue(value: string): { provider: string; model: string } | null {
  try {
    const v = JSON.parse(value) as unknown;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'string' && x.length > 0)) return null;
    return { provider: v[0] as string, model: v[1] as string };
  } catch {
    return null;
  }
}

export function findModelOption(options: ConfigOptionLike[]): ConfigOptionLike | undefined {
  return options.find((o) => o.type === 'select' && (o.category === 'model' || o.id === 'model' || /model/i.test(o.id)));
}

export function findEffortOption(options: ConfigOptionLike[]): ConfigOptionLike | undefined {
  return options.find((o) => o.type === 'select' && (o.category === 'thought_level' || /effort|thinking|reasoning/i.test(o.id)));
}

/**
 * The model catalog an ACP session advertises, with each entry's raw option value. A live session
 * and a pre-session catalog probe both use this, so New Session offers exactly the ids `setModel`
 * accepts once the session runs.
 */
export function acpModelCatalog(options: ConfigOptionLike[], fallbackProvider: string): { model: ModelInfo; value: string }[] {
  const opt = findModelOption(options);
  if (!opt) return [];
  const eff = findEffortOption(options);
  // Agents can advertise values the app does not model (none, auto, numeric levels); drop them at the boundary.
  // An option left with none is not a claim that the model takes no effort (`[]`), so it stays unknown.
  const levels = eff ? flattenSelect(eff).map((o) => o.value).filter(isEffortLevel) : [];
  const efforts = levels.length ? levels : undefined;
  return flattenSelect(opt).map((o) => {
    // dsh-style agents advertise the route as a JSON [provider, model] tuple; expose the bare
    // model id and real provider so model refs stay clean, and keep the raw value for setting.
    const decoded = decodeAcpModelValue(o.value);
    return {
      value: o.value,
      model: {
        id: decoded?.model ?? o.value,
        provider: decoded?.provider ?? fallbackProvider,
        displayName: o.name || decoded?.model || o.value,
        description: o.description ?? undefined,
        supportedEfforts: efforts,
        isDefault: o.value === opt.currentValue
      }
    };
  });
}
