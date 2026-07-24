export interface DashboardVariable {
  name?: string;
  current?: {
    value?: unknown;
    text?: unknown;
  };
  options?: Array<{
    selected?: boolean;
    value?: unknown;
    text?: unknown;
  }>;
}

export interface DashboardPanel {
  id?: number;
  title?: string;
  type?: string;
  datasource?: unknown;
  targets?: Array<Record<string, unknown>>;
  panels?: DashboardPanel[];
}

interface ResolvedDatasource {
  uid: string;
  type?: string;
}

type DatasourceLookupResponse = {
  uid?: string;
  type?: string;
};

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && value !== "$__all") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstString(item);
      if (hit) return hit;
    }
  }

  return undefined;
}

function parseTemplateToken(raw: string): string | null {
  const trimmed = raw.trim();

  const bracket = trimmed.match(/^\[\[([^\]]+)\]\]$/);
  if (bracket) {
    return bracket[1].split(":")[0];
  }

  const simple = trimmed.match(/^\$([A-Za-z0-9_\-]+)$/);
  if (simple) {
    return simple[1];
  }

  const wrapped = trimmed.match(/^\$\{([^}]+)\}$/);
  if (wrapped) {
    return wrapped[1].split(":")[0];
  }

  return null;
}

function isUnresolvedTemplate(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.startsWith("$") ||
    (trimmed.startsWith("[[") && trimmed.endsWith("]]"))
  );
}

function resolveTemplateValue(
  raw: string,
  templateValues: Map<string, string>,
): string | undefined {
  const token = parseTemplateToken(raw);
  if (token) {
    return templateValues.get(token);
  }

  if (templateValues.has(raw)) {
    return templateValues.get(raw);
  }

  return raw;
}

function resolveDatasourceRefCandidate(
  raw: unknown,
  templateValues: Map<string, string>,
): ResolvedDatasource | null {
  if (!raw) return null;

  if (typeof raw === "string") {
    const resolvedUid = resolveTemplateValue(raw, templateValues);
    if (!resolvedUid || isUnresolvedTemplate(resolvedUid)) {
      return null;
    }

    return { uid: resolvedUid };
  }

  if (typeof raw === "object") {
    const ds = raw as { uid?: unknown; type?: unknown };
    const uidRaw = typeof ds.uid === "string" ? ds.uid : undefined;
    const typeRaw = typeof ds.type === "string" ? ds.type : undefined;

    const resolvedUid = uidRaw
      ? resolveTemplateValue(uidRaw, templateValues)
      : undefined;
    const resolvedType = typeRaw
      ? resolveTemplateValue(typeRaw, templateValues)
      : typeRaw;

    if (resolvedUid && !isUnresolvedTemplate(resolvedUid)) {
      return {
        uid: resolvedUid,
        type: resolvedType,
      };
    }
  }

  return null;
}

export function flattenPanels(panels: DashboardPanel[]): DashboardPanel[] {
  const flattened: DashboardPanel[] = [];

  const visit = (nodes: DashboardPanel[]) => {
    for (const panel of nodes) {
      flattened.push(panel);
      if (Array.isArray(panel.panels) && panel.panels.length > 0) {
        visit(panel.panels);
      }
    }
  };

  visit(panels);
  return flattened;
}

export function getTemplateValueMap(
  variables: DashboardVariable[] | undefined,
): Map<string, string> {
  const values = new Map<string, string>();
  if (!variables) return values;

  for (const variable of variables) {
    if (!variable.name) continue;

    const fromCurrent =
      firstString(variable.current?.value) ??
      firstString(variable.current?.text);
    if (fromCurrent) {
      values.set(variable.name, fromCurrent);
      continue;
    }

    const selected = variable.options?.find((option) => option.selected);
    const fromSelected =
      firstString(selected?.value) ?? firstString(selected?.text);
    if (fromSelected) {
      values.set(variable.name, fromSelected);
    }
  }

  return values;
}

export function getResolvableDatasourceUid(
  panelDatasource: unknown,
  templateValues: Map<string, string>,
): string | null {
  const resolved = resolveDatasourceRefCandidate(
    panelDatasource,
    templateValues,
  );
  return resolved?.uid ?? null;
}

async function lookupDatasourceByUidOrName(
  candidate: string,
  fetcher: (path: string) => Promise<unknown>,
): Promise<ResolvedDatasource | null> {
  const encoded = encodeURIComponent(candidate);

  try {
    const byUid = (await fetcher(
      `/api/datasources/uid/${encoded}`,
    )) as DatasourceLookupResponse;
    if (typeof byUid.uid === "string" && byUid.uid.length > 0) {
      return {
        uid: byUid.uid,
        type: typeof byUid.type === "string" ? byUid.type : undefined,
      };
    }
  } catch {
    // Fall through to name lookup.
  }

  try {
    const byName = (await fetcher(
      `/api/datasources/name/${encoded}`,
    )) as DatasourceLookupResponse;
    if (typeof byName.uid === "string" && byName.uid.length > 0) {
      return {
        uid: byName.uid,
        type: typeof byName.type === "string" ? byName.type : undefined,
      };
    }
  } catch {
    // If both lookups fail, return null.
  }

  return null;
}

export async function buildPanelQueries(
  panel: DashboardPanel,
  templateValues: Map<string, string>,
  fetcher: (path: string) => Promise<unknown>,
): Promise<{
  queries: Array<Record<string, unknown>>;
  unresolvedTargetIndexes: number[];
}> {
  const cache = new Map<string, ResolvedDatasource | null>();

  const resolveDatasource = async (
    datasourceRaw: unknown,
  ): Promise<ResolvedDatasource | null> => {
    const candidate = resolveDatasourceRefCandidate(
      datasourceRaw,
      templateValues,
    );
    if (!candidate?.uid) {
      return null;
    }

    if (cache.has(candidate.uid)) {
      return cache.get(candidate.uid) ?? null;
    }

    const lookedUp = await lookupDatasourceByUidOrName(candidate.uid, fetcher);
    if (lookedUp) {
      cache.set(candidate.uid, lookedUp);
      return lookedUp;
    }

    cache.set(candidate.uid, candidate);
    return candidate;
  };

  const targets = panel.targets ?? [];
  const unresolvedTargetIndexes: number[] = [];
  const queries: Array<Record<string, unknown>> = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const targetDatasource = (target as { datasource?: unknown }).datasource;
    const resolvedDatasource = await resolveDatasource(
      targetDatasource ?? panel.datasource,
    );

    if (!resolvedDatasource) {
      unresolvedTargetIndexes.push(i);
      continue;
    }

    queries.push({
      ...target,
      refId:
        typeof target.refId === "string"
          ? target.refId
          : String.fromCharCode(65 + i),
      datasource: resolvedDatasource,
    });
  }

  return {
    queries,
    unresolvedTargetIndexes,
  };
}

export function sanitizeNumericSeries(
  rawTimestamps: unknown[],
  rawValues: unknown[],
): { timestamps: number[]; values: number[] } {
  const timestamps: number[] = [];
  const values: number[] = [];

  const size = Math.min(rawTimestamps.length, rawValues.length);
  for (let i = 0; i < size; i++) {
    const ts = Number(rawTimestamps[i]);
    const value = Number(rawValues[i]);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) {
      continue;
    }

    timestamps.push(ts);
    values.push(value);
  }

  return { timestamps, values };
}
