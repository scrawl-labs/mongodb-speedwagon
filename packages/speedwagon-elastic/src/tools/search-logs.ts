import { z } from "zod";
import { esPost } from "../client.js";
import { config } from "../config.js";
import {
  diagnosticsFallbackConfig,
  fallbackFields,
  keywordFieldCandidates,
} from "./field-fallbacks.js";

export const searchLogsSchema = z.object({
  index: z
    .string()
    .describe(
      "Index pattern (e.g. 'logs-*', 'filebeat-*', 'kubernetes-logs-*')",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Free-text search query (Lucene syntax, e.g. 'error AND timeout')",
    ),
  level: z
    .string()
    .optional()
    .describe("Log level filter (e.g. 'error', 'warn', 'info', 'access')"),
  user: z.string().optional().describe("Filter by user identifier"),
  uri: z.string().optional().describe("Filter by request URI or path"),
  service: z.string().optional().describe("Filter by service/app name"),
  status_code: z
    .number()
    .optional()
    .describe("Filter by HTTP status code (e.g. 500)"),
  method: z
    .string()
    .optional()
    .describe("Filter by HTTP method (e.g. GET, POST)"),
  from: z
    .string()
    .optional()
    .default("now-1h")
    .describe("Start time (default: now-1h)"),
  to: z.string().optional().default("now").describe("End time (default: now)"),
  size: z
    .number()
    .optional()
    .default(50)
    .describe("Number of log entries to return (default: 50, max: 200)"),
});

export type SearchLogsInput = z.infer<typeof searchLogsSchema>;

function namedTerm(
  field: string,
  value: string | number,
  name: string,
): Record<string, unknown> {
  return {
    term: {
      [field]: {
        value,
        _name: name,
      },
    },
  };
}

function namedWildcard(
  field: string,
  value: string,
  name: string,
): Record<string, unknown> {
  return {
    wildcard: {
      [field]: {
        value,
        _name: name,
      },
    },
  };
}

function namedMatch(
  field: string,
  value: string,
  name: string,
): Record<string, unknown> {
  return {
    match: {
      [field]: {
        query: value,
        _name: name,
      },
    },
  };
}

export async function searchLogs(input: SearchLogsInput): Promise<string> {
  const f = config.fieldMap;

  const must: unknown[] = [
    {
      range: {
        [f.timestamp]: {
          gte: input.from,
          lte: input.to,
        },
      },
    },
  ];

  if (input.query) {
    must.push({ query_string: { query: input.query } });
  }

  if (input.level) {
    const normalized = input.level.toLowerCase();
    must.push({
      bool: {
        should: fallbackFields("level").map((field) =>
          namedTerm(field, normalized, `level:${field}`),
        ),
        minimum_should_match: 1,
      },
    });
  }

  if (input.user) {
    must.push({ match: { [f.user]: input.user } });
  }

  if (input.uri) {
    must.push({
      bool: {
        should: keywordFieldCandidates("uri").map((field) =>
          namedWildcard(field, `*${input.uri}*`, `uri:${field}`),
        ),
        minimum_should_match: 1,
      },
    });
  }

  if (input.service) {
    must.push({
      bool: {
        should: keywordFieldCandidates("service").map((field) =>
          namedTerm(field, input.service as string, `service:${field}`),
        ),
        minimum_should_match: 1,
      },
    });
  }

  if (input.status_code) {
    must.push({
      bool: {
        should: fallbackFields("status_code").map((field) =>
          namedTerm(field, input.status_code as number, `status_code:${field}`),
        ),
        minimum_should_match: 1,
      },
    });
  }

  if (input.method) {
    const normalized = input.method.toUpperCase();
    must.push({
      bool: {
        should: fallbackFields("method").flatMap((field) => [
          namedTerm(field, normalized, `method:${field}:upper`),
          namedTerm(field, normalized.toLowerCase(), `method:${field}:lower`),
        ]),
        minimum_should_match: 1,
      },
    });
  }

  const size = Math.min(input.size ?? 50, 200);

  const result = await esPost<{
    hits: {
      total: { value: number };
      hits: Array<{
        _index: string;
        _source: Record<string, unknown>;
        matched_queries?: string[];
      }>;
    };
  }>(`/${input.index}/_search`, {
    query: { bool: { must } },
    sort: [{ [f.timestamp]: "desc" }],
    size,
    _source: true,
  });

  const hits = result.hits.hits.map((h) => ({
    index: h._index,
    ...h._source,
  }));

  const appliedFallbacks = new Set<string>();
  for (const hit of result.hits.hits) {
    for (const name of hit.matched_queries ?? []) {
      appliedFallbacks.add(name);
    }
  }

  return JSON.stringify(
    {
      total: result.hits.total.value,
      returned: hits.length,
      fieldMap: f,
      diagnostics: {
        configuredFallbacks: diagnosticsFallbackConfig(),
        appliedFallbacks: Array.from(appliedFallbacks).sort(),
      },
      logs: hits,
    },
    null,
    2,
  );
}
