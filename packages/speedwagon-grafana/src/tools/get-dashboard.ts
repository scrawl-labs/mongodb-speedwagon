import { z } from "zod";
import { grafanaGet } from "../client.js";
import {
  flattenPanels,
  getResolvableDatasourceUid,
  getTemplateValueMap,
  type DashboardPanel,
  type DashboardVariable,
} from "./dashboard-utils.js";

export const getDashboardSchema = z.object({
  uid: z.string().describe("Dashboard UID"),
});

export type GetDashboardInput = z.infer<typeof getDashboardSchema>;

interface DashboardResponse {
  dashboard: {
    uid: string;
    title: string;
    tags: string[];
    panels: DashboardPanel[];
    templating?: { list?: DashboardVariable[] };
    time?: { from: string; to: string };
  };
  meta: {
    folderTitle?: string;
    url: string;
  };
}

export async function getDashboard(input: GetDashboardInput): Promise<string> {
  const data = await grafanaGet<DashboardResponse>(
    `/api/dashboards/uid/${input.uid}`,
  );
  const { dashboard, meta } = data;
  const templateValues = getTemplateValueMap(dashboard.templating?.list);
  const flatPanels = flattenPanels(dashboard.panels ?? []);

  const panels = flatPanels
    .filter((p) => typeof p.id === "number")
    .map((p) => ({
      id: p.id,
      title: p.title ?? "",
      type: p.type ?? "unknown",
      datasourceUid: getResolvableDatasourceUid(p.datasource, templateValues),
      hasTargets: Boolean(p.targets?.length),
    }));

  return JSON.stringify(
    {
      uid: dashboard.uid,
      title: dashboard.title,
      folder: meta.folderTitle ?? null,
      tags: dashboard.tags,
      url: meta.url,
      timeRange: dashboard.time ?? null,
      panels,
    },
    null,
    2,
  );
}
