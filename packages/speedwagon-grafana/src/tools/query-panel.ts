import { z } from "zod";
import { grafanaGet, grafanaPost } from "../client.js";
import {
  buildPanelQueries,
  flattenPanels,
  getTemplateValueMap,
  type DashboardPanel,
  type DashboardVariable,
} from "./dashboard-utils.js";

export const queryPanelSchema = z.object({
  uid: z.string().describe("Dashboard UID"),
  panelId: z.number().describe("Panel ID (from get_dashboard result)"),
  from: z
    .string()
    .optional()
    .describe(
      "Start time (e.g. 'now-1h', '2026-06-30T00:00:00Z'). Defaults to dashboard's time range.",
    ),
  to: z
    .string()
    .optional()
    .describe(
      "End time (e.g. 'now', '2026-06-30T12:00:00Z'). Defaults to dashboard's time range.",
    ),
});

export type QueryPanelInput = z.infer<typeof queryPanelSchema>;

interface DashboardResponse {
  dashboard: {
    uid: string;
    title: string;
    panels: DashboardPanel[];
    templating?: { list?: DashboardVariable[] };
    time?: { from: string; to: string };
  };
}

export async function queryPanel(input: QueryPanelInput): Promise<string> {
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
    throw new Error(`Panel "${panel.title}" has no query targets.`);
  }

  const timeRange = {
    from: input.from ?? data.dashboard.time?.from ?? "now-1h",
    to: input.to ?? data.dashboard.time?.to ?? "now",
  };

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
    from: timeRange.from,
    to: timeRange.to,
  });

  return JSON.stringify(
    {
      panel: {
        id: panel.id,
        title: panel.title ?? "",
        type: panel.type ?? "unknown",
      },
      timeRange,
      warnings:
        unresolvedTargetIndexes.length > 0
          ? [
              `Skipped targets with unresolved datasource at indexes: ${unresolvedTargetIndexes.join(", ")}`,
            ]
          : [],
      result,
    },
    null,
    2,
  );
}
