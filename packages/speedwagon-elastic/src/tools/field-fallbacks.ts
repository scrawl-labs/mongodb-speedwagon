import { config } from "../config.js";

export type LogicalField =
  | "level"
  | "service"
  | "uri"
  | "method"
  | "status_code"
  | "message";

const STATIC_FALLBACKS: Record<LogicalField, string[]> = {
  level: ["log_name", "log.level", "level"],
  service: ["app_name", "service.name"],
  uri: ["parsed_log.url", "url.path", "request_uri"],
  method: ["parsed_log.http_method", "http.request.method", "method"],
  status_code: [
    "parsed_log.status_code",
    "http.response.status_code",
    "status_code",
  ],
  message: ["log", "message"],
};

function dedupe(fields: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const field of fields) {
    const trimmed = field.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

export function fallbackFields(logicalField: LogicalField): string[] {
  const primary = config.fieldMap[logicalField];
  return dedupe([primary, ...STATIC_FALLBACKS[logicalField]]);
}

export function keywordFieldCandidates(logicalField: LogicalField): string[] {
  return fallbackFields(logicalField).flatMap((field) => [
    field,
    `${field}.keyword`,
  ]);
}

export function diagnosticsFallbackConfig(): Record<LogicalField, string[]> {
  return {
    level: fallbackFields("level"),
    service: fallbackFields("service"),
    uri: fallbackFields("uri"),
    method: fallbackFields("method"),
    status_code: fallbackFields("status_code"),
    message: fallbackFields("message"),
  };
}
