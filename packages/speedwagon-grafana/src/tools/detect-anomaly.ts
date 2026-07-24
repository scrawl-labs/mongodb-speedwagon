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

export const detectAnomalySchema = z.object({
  uid: z.string().describe("Dashboard UID"),
  panelId: z.number().describe("Panel ID"),
  from: z
    .string()
    .optional()
    .default("now-6h")
    .describe("Start time (default: now-6h)"),
  to: z.string().optional().default("now").describe("End time (default: now)"),
  sensitivity: z
    .number()
    .optional()
    .default(2.5)
    .describe(
      "Z-score threshold for anomaly detection (default: 2.5, lower = more sensitive)",
    ),
});

export type DetectAnomalyInput = z.infer<typeof detectAnomalySchema>;

interface DashboardResponse {
  dashboard: {
    panels: DashboardPanel[];
    templating?: { list?: DashboardVariable[] };
  };
}

interface Anomaly {
  timestamp: string;
  value: number;
  zScore: number;
  severity: "warning" | "critical";
  direction: "spike" | "drop";
}

interface SeriesStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  count: number;
}

function computeStats(values: number[]): SeriesStats {
  const count = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / count;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / count;
  const stddev = Math.sqrt(variance);

  return {
    mean,
    stddev,
    min: Math.min(...values),
    max: Math.max(...values),
    count,
  };
}

function detectAnomalies(
  timestamps: number[],
  values: number[],
  threshold: number,
): Anomaly[] {
  const stats = computeStats(values);
  if (stats.stddev === 0) return [];

  const anomalies: Anomaly[] = [];
  for (let i = 0; i < values.length; i++) {
    const zScore = (values[i] - stats.mean) / stats.stddev;
    const absZ = Math.abs(zScore);

    if (absZ >= threshold) {
      anomalies.push({
        timestamp: new Date(timestamps[i]).toISOString(),
        value: values[i],
        zScore: Math.round(zScore * 100) / 100,
        severity: absZ >= threshold * 1.5 ? "critical" : "warning",
        direction: zScore > 0 ? "spike" : "drop",
      });
    }
  }

  return anomalies;
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

export async function detectAnomaly(
  input: DetectAnomalyInput,
): Promise<string> {
  const data = await grafanaGet<DashboardResponse>(
    `/api/dashboards/uid/${input.uid}`,
  );
  const flatPanels = flattenPanels(data.dashboard.panels ?? []);
  const panel = flatPanels.find((p) => p.id === input.panelId);
  const templateValues = getTemplateValueMap(data.dashboard.templating?.list);

  if (!panel) {
    const ids = flatPanels
      .filter((p) => typeof p.id === "number")
      .map((p) => `${p.id}: ${p.title ?? ""}`)
      .join(", ");
    throw new Error(`Panel ${input.panelId} not found. Available: ${ids}`);
  }

  if (!panel.targets?.length) {
    throw new Error(`Panel "${panel.title ?? ""}" has no queryable targets.`);
  }

  const { queries, unresolvedTargetIndexes } = await buildPanelQueries(
    panel,
    templateValues,
    grafanaGet,
  );

  if (queries.length === 0) {
    throw new Error(
      `Panel "${panel.title ?? ""}" has no queryable targets after datasource resolution.`,
    );
  }

  const result = await grafanaPost("/api/ds/query", {
    queries,
    from: input.from,
    to: input.to,
  });

  const allSeries = extractTimeSeries(result);

  if (allSeries.length === 0) {
    return JSON.stringify(
      {
        panel: { id: panel.id, title: panel.title ?? "" },
        timeRange: { from: input.from, to: input.to },
        warnings:
          unresolvedTargetIndexes.length > 0
            ? [
                `Skipped targets with unresolved datasource at indexes: ${unresolvedTargetIndexes.join(", ")}`,
              ]
            : [],
        message: "No time series data returned from panel queries.",
        anomalies: [],
      },
      null,
      2,
    );
  }

  const seriesResults = allSeries.map((s) => {
    const stats = computeStats(s.values);
    const anomalies = detectAnomalies(
      s.timestamps,
      s.values,
      input.sensitivity,
    );
    return {
      name: s.name,
      stats: {
        mean: Math.round(stats.mean * 1000) / 1000,
        stddev: Math.round(stats.stddev * 1000) / 1000,
        min: Math.round(stats.min * 1000) / 1000,
        max: Math.round(stats.max * 1000) / 1000,
        dataPoints: stats.count,
      },
      anomalyCount: anomalies.length,
      anomalies,
    };
  });

  const totalAnomalies = seriesResults.reduce(
    (sum, s) => sum + s.anomalyCount,
    0,
  );

  return JSON.stringify(
    {
      panel: { id: panel.id, title: panel.title ?? "" },
      timeRange: { from: input.from, to: input.to },
      warnings:
        unresolvedTargetIndexes.length > 0
          ? [
              `Skipped targets with unresolved datasource at indexes: ${unresolvedTargetIndexes.join(", ")}`,
            ]
          : [],
      sensitivity: input.sensitivity,
      totalAnomalies,
      series: seriesResults,
    },
    null,
    2,
  );
}
