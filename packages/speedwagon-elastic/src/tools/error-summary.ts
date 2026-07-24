import { z } from "zod";
import { esPost } from "../client.js";
import { config } from "../config.js";
import {
  diagnosticsFallbackConfig,
  fallbackFields,
  keywordFieldCandidates,
  type LogicalField,
} from "./field-fallbacks.js";

export const errorSummarySchema = z.object({
  index: z
    .string()
    .describe("Index pattern (e.g. 'logs-*', 'kubernetes-logs-*')"),
  from: z
    .string()
    .optional()
    .default("now-24h")
    .describe("Start time (default: now-24h)"),
  to: z.string().optional().default("now").describe("End time (default: now)"),
  service: z.string().optional().describe("Filter by service name"),
  group_by: z
    .enum(["message", "uri", "service", "status_code"])
    .optional()
    .default("message")
    .describe(
      "Group errors by: message (default), uri, service, or status_code",
    ),
  size: z
    .number()
    .optional()
    .default(20)
    .describe("Number of top error groups (default: 20)"),
});

export type ErrorSummaryInput = z.infer<typeof errorSummarySchema>;

function toLogicalField(groupBy: string): LogicalField {
  if (groupBy === "message") return "message";
  if (groupBy === "uri") return "uri";
  if (groupBy === "service") return "service";
  return "status_code";
}

function termShould(fieldNames: string[], value: string | number): unknown {
  return {
    bool: {
      should: fieldNames.map((field) => ({ term: { [field]: value } })),
      minimum_should_match: 1,
    },
  };
}

function rangeShould(
  fieldNames: string[],
  range: Record<string, number>,
): unknown {
  return {
    bool: {
      should: fieldNames.map((field) => ({ range: { [field]: range } })),
      minimum_should_match: 1,
    },
  };
}

function bucketScript(logicalField: LogicalField): string {
  if (logicalField === "status_code") {
    const fields = fallbackFields("status_code");
    const lines = fields
      .map(
        (field) =>
          `if (doc.containsKey('${field}') && !doc['${field}'].empty) return String.valueOf(doc['${field}'].value);`,
      )
      .join("\n");
    return `${lines}\nreturn 'unknown';`;
  }

  const fields = keywordFieldCandidates(logicalField).filter((field) =>
    field.endsWith(".keyword"),
  );
  const lines = fields
    .map(
      (field) =>
        `if (doc.containsKey('${field}') && !doc['${field}'].empty) return String.valueOf(doc['${field}'].value);`,
    )
    .join("\n");
  return `${lines}\nreturn 'unknown';`;
}

export async function errorSummary(input: ErrorSummaryInput): Promise<string> {
  const f = config.fieldMap;
  const groupLogicalField = toLogicalField(input.group_by);

  const levelFields = fallbackFields("level");
  const statusFields = fallbackFields("status_code");
  const serviceFields = keywordFieldCandidates("service");

  const must: unknown[] = [
    {
      range: {
        [f.timestamp]: {
          gte: input.from,
          lte: input.to,
        },
      },
    },
    {
      bool: {
        should: [
          termShould(levelFields, "error"),
          rangeShould(statusFields, { gte: 500 }),
        ],
        minimum_should_match: 1,
      },
    },
  ];

  if (input.service) {
    must.push(termShould(serviceFields, input.service));
  }

  const aggs: Record<string, unknown> = {
    top_groups: {
      terms: {
        script: {
          lang: "painless",
          source: bucketScript(groupLogicalField),
        },
        size: input.size ?? 20,
        order: { _count: "desc" },
      },
    },
    over_time: {
      date_histogram: {
        field: f.timestamp,
        fixed_interval: "1h",
      },
    },
  };

  const result = await esPost<{
    hits: { total: { value: number } };
    aggregations: {
      top_groups: {
        buckets: Array<{ key: string | number; doc_count: number }>;
      };
      over_time: {
        buckets: Array<{ key: string | number; doc_count: number }>;
      };
    };
  }>(`/${input.index}/_search`, {
    query: { bool: { must } },
    aggs,
    size: 0,
  });

  const topErrors = (result.aggregations?.top_groups?.buckets ?? []).map(
    (b) => ({
      key: b.key,
      count: b.doc_count,
    }),
  );

  const timeline = (result.aggregations?.over_time?.buckets ?? []).map((b) => ({
    time: new Date(b.key).toISOString(),
    count: b.doc_count,
  }));

  return JSON.stringify(
    {
      timeRange: { from: input.from, to: input.to },
      totalErrors: result.hits.total.value,
      groupedBy: input.group_by,
      diagnostics: {
        configuredFallbacks: diagnosticsFallbackConfig(),
        appliedFallbacks: {
          service: serviceFields,
          level: levelFields,
          status_code: statusFields,
          groupBy: groupLogicalField,
        },
      },
      topErrors,
      timeline,
    },
    null,
    2,
  );
}
