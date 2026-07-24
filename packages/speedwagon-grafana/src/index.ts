#!/usr/bin/env node
import { runMcpServer, defineTool } from "@scrawl-labs/speedwagon";
import { searchDashboardsSchema, searchDashboards } from "./tools/search.js";
import { getDashboardSchema, getDashboard } from "./tools/get-dashboard.js";
import { queryPanelSchema, queryPanel } from "./tools/query-panel.js";
import { detectAnomalySchema, detectAnomaly } from "./tools/detect-anomaly.js";
import {
  incidentTimelineSchema,
  incidentTimeline,
} from "./tools/incident-timeline.js";
import {
  dailyReportSchema,
  dailyReport,
  dailyMorningBriefingSchema,
  dailyMorningBriefing,
} from "./tools/daily-report.js";

runMcpServer({
  name: "speedwagon-grafana",
  version: "0.2.0",
  tools: [
    defineTool({
      name: "search_dashboards",
      description:
        "Search Grafana dashboards by title, folder name, or tag. Returns UID, title, folder, and tags for each match.",
      inputSchema: searchDashboardsSchema,
      annotations: { readOnlyHint: true },
      handler: searchDashboards,
    }),
    defineTool({
      name: "get_dashboard",
      description:
        "Get dashboard details including all panels (id, title, type, datasource). Use the panel IDs with query_panel to fetch actual metric data.",
      inputSchema: getDashboardSchema,
      annotations: { readOnlyHint: true },
      handler: getDashboard,
    }),
    defineTool({
      name: "query_panel",
      description:
        "Query a specific panel's metric data. Executes the panel's configured queries against its datasource and returns time series results.",
      inputSchema: queryPanelSchema,
      annotations: { readOnlyHint: true },
      handler: queryPanel,
    }),
    defineTool({
      name: "detect_anomaly",
      description:
        "Detect anomalies (spikes/drops) in a panel's metric data using z-score statistical analysis. Returns anomalous data points with timestamps, severity, and direction.",
      inputSchema: detectAnomalySchema,
      annotations: { readOnlyHint: true },
      handler: detectAnomaly,
    }),
    defineTool({
      name: "incident_timeline",
      description:
        "Build a chronological incident timeline from Grafana alerts and annotations within a time range. Shows alert state changes, active alerts, and manual annotations.",
      inputSchema: incidentTimelineSchema,
      annotations: { readOnlyHint: true },
      handler: incidentTimeline,
    }),
    defineTool({
      name: "daily_morning_report",
      description:
        "Generate a morning report for today's dashboard metrics (latest/avg/min/max) and optionally check Elasticsearch HTTP 500 errors for the same period.",
      inputSchema: dailyReportSchema,
      annotations: { readOnlyHint: true },
      handler: dailyReport,
    }),
    defineTool({
      name: "daily_morning_briefing",
      description:
        "Generate one combined morning briefing across multiple dashboards. Reuses daily morning reports and aggregates success/failure and HTTP 500 totals.",
      inputSchema: dailyMorningBriefingSchema,
      annotations: { readOnlyHint: true },
      handler: dailyMorningBriefing,
    }),
  ],
}).catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
