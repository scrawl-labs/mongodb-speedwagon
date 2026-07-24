# @scrawl-labs/speedwagon-elastic

Elasticsearch MCP server — log search, error aggregation, and index discovery via Elasticsearch REST API. Read-only.

## Install

```bash
npm install -g @scrawl-labs/speedwagon-elastic
```

## Configuration

### Environment Variables

| Variable                  | Required | Description                                                 |
| ------------------------- | -------- | ----------------------------------------------------------- |
| `ELASTICSEARCH_URL`       | Yes      | Elasticsearch endpoint (e.g. `https://es.example.com:9200`) |
| `ELASTICSEARCH_API_KEY`   | Yes      | API key for authentication                                  |
| `ELASTICSEARCH_FIELD_MAP` | No       | JSON field name mapping (see below)                         |

### API Key Setup

Create a read-only API key:

```json
POST /_security/api_key
{
  "name": "speedwagon-readonly",
  "role_descriptors": {
    "readonly": {
      "indices": [
        {
          "names": ["logs-*", "kubernetes-logs-*"],
          "privileges": ["read"]
        }
      ]
    }
  }
}
```

### Field Mapping

Every team's log format is different. `ELASTICSEARCH_FIELD_MAP` lets you tell the server which fields to query — no code changes needed.

`search_logs` and `error_summary` now include built-in fallback candidates (for example `parsed_log.status_code`, `parsed_log.url`, `app_name`, `log_name`) even when your field map is ECS-based. For best accuracy/performance, still set `ELASTICSEARCH_FIELD_MAP` to your real schema.

**Default (ECS — Elastic Common Schema):**

```json
{
  "timestamp": "@timestamp",
  "level": "log.level",
  "message": "message",
  "uri": "url.path",
  "method": "http.request.method",
  "status_code": "http.response.status_code",
  "user": "user.id",
  "service": "service.name",
  "user_agent": "user_agent.original"
}
```

**Custom example (Kubernetes + Kafka pipeline):**

```json
{
  "timestamp": "log_time",
  "level": "log_name",
  "message": "log",
  "uri": "parsed_log.url",
  "method": "parsed_log.http_method",
  "status_code": "parsed_log.status_code",
  "user": "parsed_log.remote_addr",
  "service": "app_name",
  "user_agent": "parsed_log.user_agent"
}
```

You only need to override the fields that differ — unspecified fields fall back to ECS defaults.

### MCP Client Configuration

```json
{
  "mcpServers": {
    "speedwagon-elastic": {
      "command": "speedwagon-elastic",
      "env": {
        "ELASTICSEARCH_URL": "https://es.example.com:9200",
        "ELASTICSEARCH_API_KEY": "your-api-key",
        "ELASTICSEARCH_FIELD_MAP": "{\"timestamp\":\"log_time\",\"level\":\"log_name\",\"message\":\"log\",\"uri\":\"parsed_log.url\",\"method\":\"parsed_log.http_method\",\"status_code\":\"parsed_log.status_code\",\"user\":\"parsed_log.remote_addr\",\"service\":\"app_name\"}"
      }
    }
  }
}
```

## Tools

### Index Discovery

| Tool           | Description                                                   |
| -------------- | ------------------------------------------------------------- |
| `list_indices` | List indices with doc count and size. Filters system indices. |

### Log Search

| Tool          | Description                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `search_logs` | Search logs by free-text query, log level, user, URI, service, HTTP method, status code, and time range |

### Error Analysis

| Tool            | Description                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- |
| `error_summary` | Top error groups with counts + hourly trend. Group by message, URI, service, or status code. |

## Usage Examples

```
"어떤 인덱스가 있어?"              → list_indices
"최근 1시간 에러 로그 보여줘"       → search_logs (level: "error")
"/api/payments 500 에러 봐줘"     → search_logs (uri: "/api/payments", status_code: 500)
"gem-operation 서비스 에러 요약"   → error_summary (service: "gem-operation")
"서비스별 에러 현황"              → error_summary (group_by: "service")
"GET /api/ping 요청 확인"        → search_logs (method: "GET", uri: "/api/ping")
"오늘 gem-operation 500 요약"    → error_summary (service: "gem-operation", group_by: "status_code")
```

## Diagnostics

`search_logs` and `error_summary` responses include `diagnostics`:

- `configuredFallbacks`: logical field -> candidate field list
- `appliedFallbacks`: which fallback clauses/fields were used during query execution

Use this to confirm whether the tool matched your real log schema or only the default ECS fields.

## License

MIT — Copyright (c) 2026 Yongtaek Lee.
