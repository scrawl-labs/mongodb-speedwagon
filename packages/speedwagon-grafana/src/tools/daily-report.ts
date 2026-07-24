import { optionalEnv } from "@scrawl-labs/speedwagon";
import { z } from "zod";
import { grafanaGet, grafanaPost } from "../client.js";
import {
  buildPanelQueries,
  flattenPanels,
  getTemplateValueMap,
  sanitizeNumericSeries,
  type DashboardPanel,
  type DashboardVariable,
} from "./dashboard-utils.js";

export const dailyReportSchema = z.object({
  uid: z.string().describe("Dashboard UID"),
  from: z
    .string()
    .optional()
    .default("now/d")
    .describe("Start time (default: now/d, start of today)"),
  to: z.string().optional().default("now").describe("End time (default: now)"),
  panelIds: z
    .array(z.number())
    .optional()
    .describe(
      "Optional panel IDs to include. If omitted, queryable panels are auto-selected.",
    ),
  panelLimit: z
    .number()
    .optional()
    .default(8)
    .describe(
      "Maximum auto-selected panels when panelIds is omitted (default: 8)",
    ),
  includeElasticsearch: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Include Elasticsearch HTTP 500 error summary for the same time range",
    ),
  elasticIndex: z
    .string()
    .optional()
    .describe(
      "Elasticsearch index pattern (required only when includeElasticsearch=true)",
    ),
  elasticService: z
    .string()
    .optional()
    .describe("Optional Elasticsearch service filter"),
  topErrorUris: z
    .number()
    .optional()
    .default(5)
    .describe("Top URI count for Elasticsearch 500 summary (default: 5)"),
});

export const dailyMorningBriefingSchema = z.object({
  dashboards: z
    .array(
      z.object({
        uid: z.string().describe("Dashboard UID"),
        panelIds: z
          .array(z.number())
          .optional()
          .describe("Optional panel IDs to include for this dashboard"),
        panelLimit: z
          .number()
          .optional()
          .default(6)
          .describe("Per-dashboard panel limit when panelIds is omitted"),
        elasticService: z
          .string()
          .optional()
          .describe("Per-dashboard Elasticsearch service filter override"),
      }),
    )
    .min(1)
    .describe("Dashboards to include in one morning briefing"),
  from: z
    .string()
    .optional()
    .default("now/d")
    .describe("Start time (default: now/d, start of today)"),
  to: z.string().optional().default("now").describe("End time (default: now)"),
  includeElasticsearch: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include Elasticsearch HTTP 500 summary for each dashboard"),
  elasticIndex: z
    .string()
    .optional()
    .describe(
      "Elasticsearch index pattern (required only when includeElasticsearch=true)",
    ),
  topErrorUris: z
    .number()
    .optional()
    .default(5)
    .describe("Top URI count for Elasticsearch 500 summary (default: 5)"),
  elasticService: z
    .string()
    .optional()
    .describe(
      "Default Elasticsearch service filter applied when dashboard override is absent",
    ),
});

export type DailyReportInput = z.infer<typeof dailyReportSchema>;
export type DailyMorningBriefingInput = z.infer<
  typeof dailyMorningBriefingSchema
>;

interface DashboardResponse {
  dashboard: {
    uid: string;
    title: string;
    panels: DashboardPanel[];
    templating?: { list?: DashboardVariable[] };
  };
}

interface SeriesStats {
  latest: number;
  average: number;
  min: number;
  max: number;
  dataPoints: number;
  lastTimestamp: string;
}

interface FieldMap {
  timestamp: string;
  status_code: string;
  uri: string;
  service: string;
}

interface EsSummary {
  enabled: boolean;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  timeRange: { from: string; to: string };
  has500Errors?: boolean;
  total500Errors?: number;
  topUris?: Array<{ uri: string; count: number }>;
}

function sanitizeUpstreamError(
  source: "Grafana" | "Elasticsearch",
  statusCode?: number,
): string {
  if (!statusCode) {
    return `${source} request failed`;
  }
  return `${source} request failed with status ${statusCode}`;
}

const DEFAULT_FIELD_MAP: FieldMap = {
  timestamp: "@timestamp",
  status_code: "http.response.status_code",
  uri: "url.path",
  service: "service.name",
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function extractTimeSeries(
  frames: unknown,
): Array<{ name: string; timestamps: number[]; values: number[] }> {
  const series: Array<{
    name: string;
    timestamps: number[];
    values: number[];
  }> = [];

  const results = (frames as Record<string, unknown>)?.results;
  if (!results || typeof results !== "object") return series;

  for (const [refId, refResult] of Object.entries(
    results as Record<string, unknown>,
  )) {
    const result = refResult as {
      frames?: Array<{
        schema?: { fields?: Array<{ name: string; type: string }> };
        data?: { values?: unknown[][] };
      }>;
    };
    if (!result.frames) continue;

    for (const frame of result.frames) {
      const fields = frame.schema?.fields ?? [];
      const dataValues = frame.data?.values ?? [];

      const timeIdx = fields.findIndex((f) => f.type === "time");
      const valueIdx = fields.findIndex((f) => f.type === "number");

      if (timeIdx === -1 || valueIdx === -1) continue;

      const timestampsRaw = (dataValues[timeIdx] as unknown[]) ?? [];
      const valuesRaw = (dataValues[valueIdx] as unknown[]) ?? [];
      const { timestamps, values } = sanitizeNumericSeries(
        timestampsRaw,
        valuesRaw,
      );
      const name = fields[valueIdx]?.name ?? refId;

      if (timestamps.length > 0 && values.length > 0) {
        series.push({ name, timestamps, values });
      }
    }
  }

  return series;
}

function computeStats(timestamps: number[], values: number[]): SeriesStats {
  const count = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  const latest = values[count - 1];
  const average = sum / count;

  return {
    latest: round3(latest),
    average: round3(average),
    min: round3(Math.min(...values)),
    max: round3(Math.max(...values)),
    dataPoints: count,
    lastTimestamp: new Date(timestamps[count - 1]).toISOString(),
  };
}

function parseFieldMap(raw: string | undefined): FieldMap {
  if (!raw) return DEFAULT_FIELD_MAP;
  try {
    const parsed = JSON.parse(raw) as Partial<FieldMap>;
    return { ...DEFAULT_FIELD_MAP, ...parsed };
  } catch {
    return DEFAULT_FIELD_MAP;
  }
}

function validateElasticIndex(index: string): string {
  const trimmed = index.trim();
  const valid = /^[a-zA-Z0-9._*,-]+$/.test(trimmed);
  if (!valid) {
    throw new Error(
      "elasticIndex contains invalid characters. Allowed: letters, numbers, dot, underscore, dash, comma, asterisk.",
    );
  }
  return trimmed;
}

async function elastic500Summary(input: DailyReportInput): Promise<EsSummary> {
  const from = input.from ?? "now/d";
  const to = input.to ?? "now";

  if (!input.includeElasticsearch) {
    return {
      enabled: false,
      status: "skipped",
      reason: "includeElasticsearch=false",
      timeRange: { from, to },
    };
  }

  if (!input.elasticIndex) {
    return {
      enabled: true,
      status: "skipped",
      reason: "elasticIndex is required when includeElasticsearch=true",
      timeRange: { from, to },
    };
  }

  let safeElasticIndex: string;
  try {
    safeElasticIndex = validateElasticIndex(input.elasticIndex);
  } catch (error) {
    return {
      enabled: true,
      status: "skipped",
      reason: error instanceof Error ? error.message : "Invalid elasticIndex",
      timeRange: { from, to },
    };
  }

  const elasticUrl = optionalEnv("ELASTICSEARCH_URL")?.replace(/\/+$/, "");
  const apiKey = optionalEnv("ELASTICSEARCH_API_KEY");
  if (!elasticUrl || !apiKey) {
    return {
      enabled: true,
      status: "skipped",
      reason: "ELASTICSEARCH_URL or ELASTICSEARCH_API_KEY is not configured",
      timeRange: { from, to },
    };
  }

  const fieldMap = parseFieldMap(optionalEnv("ELASTICSEARCH_FIELD_MAP"));

  const must: unknown[] = [
    {
      range: {
        [fieldMap.timestamp]: {
          gte: from,
          lte: to,
        },
      },
    },
    {
      range: {
        [fieldMap.status_code]: { gte: 500, lt: 600 },
      },
    },
  ];

  if (input.elasticService) {
    must.push({ term: { [fieldMap.service]: input.elasticService } });
  }

  const topUriField = `${fieldMap.uri}.keyword`;
  const topUriSize = Math.max(1, Math.min(input.topErrorUris ?? 5, 20));

  try {
    const indexPath = safeElasticIndex
      .split(",")
      .map((segment) => encodeURIComponent(segment.trim()))
      .join(",");

    const res = await fetch(`${elasticUrl}/${indexPath}/_search`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: { bool: { must } },
        aggs: {
          top_uris: {
            terms: {
              field: topUriField,
              size: topUriSize,
              order: { _count: "desc" },
            },
          },
        },
        size: 0,
      }),
    });

    if (!res.ok) {
      await res.text();
      return {
        enabled: true,
        status: "failed",
        reason: sanitizeUpstreamError("Elasticsearch", res.status),
        timeRange: { from, to },
      };
    }

    const body = (await res.json()) as {
      hits?: { total?: { value?: number } };
      aggregations?: {
        top_uris?: { buckets?: Array<{ key: string; doc_count: number }> };
      };
    };

    const total500Errors = body.hits?.total?.value ?? 0;
    const topUris = (body.aggregations?.top_uris?.buckets ?? []).map((b) => ({
      uri: b.key,
      count: b.doc_count,
    }));

    return {
      enabled: true,
      status: "ok",
      timeRange: { from, to },
      has500Errors: total500Errors > 0,
      total500Errors,
      topUris,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? sanitizeUpstreamError("Elasticsearch")
        : "Elasticsearch request failed";
    return {
      enabled: true,
      status: "failed",
      reason: message,
      timeRange: { from, to },
    };
  }
}

export async function dailyReport(input: DailyReportInput): Promise<string> {
  const warnings: string[] = [];
  const from = input.from ?? "now/d";
  const to = input.to ?? "now";

  const data = await grafanaGet<DashboardResponse>(
    `/api/dashboards/uid/${input.uid}`,
  );
  const allPanels = flattenPanels(data.dashboard.panels ?? []);
  const templateValues = getTemplateValueMap(data.dashboard.templating?.list);

  const queryablePanels = allPanels.filter(
    (p) => typeof p.id === "number" && Boolean(p.targets?.length),
  );
  const selectedPanels =
    input.panelIds && input.panelIds.length > 0
      ? queryablePanels.filter(
          (p) => typeof p.id === "number" && input.panelIds?.includes(p.id),
        )
      : queryablePanels.slice(
          0,
          Math.max(1, Math.min(input.panelLimit ?? 8, 20)),
        );

  if (selectedPanels.length === 0) {
    throw new Error(
      "No queryable panels found for report. Check panel datasource/targets or panelIds filter.",
    );
  }

  if (input.panelIds && input.panelIds.length > 0) {
    const selectedIds = new Set(
      selectedPanels
        .map((p) => p.id)
        .filter((id): id is number => typeof id === "number"),
    );
    const missing = input.panelIds.filter((id) => !selectedIds.has(id));
    if (missing.length > 0) {
      warnings.push(
        `Some panelIds were not queryable or not found: ${missing.join(", ")}`,
      );
    }
  }

  const panelSummaries = await Promise.all(
    selectedPanels.map(async (panel) => {
      try {
        const { queries, unresolvedTargetIndexes } = await buildPanelQueries(
          panel,
          templateValues,
          grafanaGet,
        );

        if (queries.length === 0) {
          throw new Error("No queryable targets after datasource resolution");
        }
        if (unresolvedTargetIndexes.length > 0) {
          warnings.push(
            `Panel ${panel.id ?? "unknown"} (${panel.title ?? ""}) skipped targets with unresolved datasource indexes: ${unresolvedTargetIndexes.join(", ")}`,
          );
        }

        const result = await grafanaPost("/api/ds/query", {
          queries,
          from,
          to,
        });

        const series = extractTimeSeries(result);
        if (series.length === 0) {
          return {
            panelId: panel.id,
            panelTitle: panel.title ?? "",
            panelType: panel.type ?? "unknown",
            status: "no_data" as const,
            series: [],
            error: "No time series returned",
          };
        }

        return {
          panelId: panel.id,
          panelTitle: panel.title ?? "",
          panelType: panel.type ?? "unknown",
          status: "ok" as const,
          series: series.map((s) => ({
            name: s.name,
            stats: computeStats(s.timestamps, s.values),
          })),
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? sanitizeUpstreamError("Grafana")
            : "Grafana panel query failed";
        warnings.push(
          `Panel ${panel.id ?? "unknown"} (${panel.title ?? ""}) failed: ${message}`,
        );
        return {
          panelId: panel.id,
          panelTitle: panel.title ?? "",
          panelType: panel.type ?? "unknown",
          status: "error" as const,
          series: [],
          error: message,
        };
      }
    }),
  );

  const es = await elastic500Summary(input);
  if (es.enabled && es.status !== "ok") {
    warnings.push(
      `Elasticsearch summary ${es.status}: ${es.reason ?? "no reason"}`,
    );
  }

  const okPanels = panelSummaries.filter((p) => p.status === "ok").length;
  const reportStatus =
    okPanels === panelSummaries.length
      ? "success"
      : okPanels > 0
        ? "partial_success"
        : "failed";

  return JSON.stringify(
    {
      reportStatus,
      generatedAt: new Date().toISOString(),
      dashboard: {
        uid: data.dashboard.uid,
        title: data.dashboard.title,
      },
      timeRange: { from, to },
      panelCount: panelSummaries.length,
      panelSummaries,
      elasticsearch: es,
      warnings,
    },
    null,
    2,
  );
}

export async function dailyMorningBriefing(
  input: DailyMorningBriefingInput,
): Promise<string> {
  const dashboardResults = await Promise.all(
    input.dashboards.map(async (dashboardInput) => {
      const request: DailyReportInput = {
        uid: dashboardInput.uid,
        from: input.from ?? "now/d",
        to: input.to ?? "now",
        panelIds: dashboardInput.panelIds,
        panelLimit: dashboardInput.panelLimit ?? 6,
        includeElasticsearch: input.includeElasticsearch ?? false,
        elasticIndex: input.elasticIndex,
        elasticService: dashboardInput.elasticService ?? input.elasticService,
        topErrorUris: input.topErrorUris ?? 5,
      };

      try {
        const reportRaw = await dailyReport(request);
        const report = JSON.parse(reportRaw) as {
          reportStatus: "success" | "partial_success" | "failed";
          dashboard: { uid: string; title: string };
          warnings?: string[];
          elasticsearch?: {
            enabled?: boolean;
            status?: "ok" | "skipped" | "failed";
            total500Errors?: number;
            has500Errors?: boolean;
            topUris?: Array<{ uri: string; count: number }>;
            reason?: string;
          };
        };

        return {
          uid: report.dashboard.uid,
          title: report.dashboard.title,
          status: report.reportStatus,
          totalHttp500: report.elasticsearch?.total500Errors ?? 0,
          hasHttp500: report.elasticsearch?.has500Errors ?? false,
          warnings: report.warnings ?? [],
          report,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Dashboard morning report failed";
        return {
          uid: dashboardInput.uid,
          title: null,
          status: "failed" as const,
          totalHttp500: 0,
          hasHttp500: false,
          warnings: [],
          report: null,
          error: {
            code: "DASHBOARD_REPORT_FAILED",
            message,
            retriable: true,
          },
        };
      }
    }),
  );

  const successCount = dashboardResults.filter(
    (r) => r.status === "success",
  ).length;
  const partialSuccessCount = dashboardResults.filter(
    (r) => r.status === "partial_success",
  ).length;
  const failureCount = dashboardResults.filter(
    (r) => r.status === "failed",
  ).length;
  const totalHttp500 = dashboardResults.reduce(
    (sum, r) => sum + r.totalHttp500,
    0,
  );

  const status =
    failureCount === dashboardResults.length
      ? "failed"
      : failureCount > 0 || partialSuccessCount > 0
        ? "partial_success"
        : "success";

  return JSON.stringify(
    {
      status,
      generatedAt: new Date().toISOString(),
      timeRange: {
        from: input.from ?? "now/d",
        to: input.to ?? "now",
      },
      aggregate: {
        totalDashboards: dashboardResults.length,
        successCount,
        partialSuccessCount,
        failureCount,
        totalHttp500,
      },
      dashboards: dashboardResults,
    },
    null,
    2,
  );
}
