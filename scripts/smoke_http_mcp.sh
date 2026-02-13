#!/usr/bin/env bash
set -euo pipefail

# Minimal smoke test for Streamable HTTP MCP via nginx Basic + per-project token header.
#
# Required env:
# - MCP_BASE_URL (e.g. https://mcp.justgpt.ru)
# - MCP_BASIC_USER (e.g. mcp)
# - MCP_BASIC_PASS
# - MCP_PROJECT_PATH (e.g. /p/my/mcp)
# - MCP_PROJECT_TOKEN
#
# Optional env:
# - MCP_PROTOCOL_VERSION (default: 2025-03-26)
# - MCP_TOOL_NAME (e.g. mysql_mysql_main_list_tables)
# - MCP_TOOL_ARGS_JSON (default: {})

require() {
  local k="$1"
  if [[ -z "${!k:-}" ]]; then
    echo "Missing env: $k" >&2
    exit 2
  fi
}

require MCP_BASE_URL
require MCP_BASIC_USER
require MCP_BASIC_PASS
require MCP_PROJECT_PATH
require MCP_PROJECT_TOKEN

MCP_PROTOCOL_VERSION="${MCP_PROTOCOL_VERSION:-2025-03-26}"
# bash parameter expansion + "{}" is tricky because "}" can be parsed as the end of ${...}.
# Use an intermediate variable to avoid accidental extra "}" in the result.
DEFAULT_ARGS_JSON='{}'
MCP_TOOL_ARGS_JSON="${MCP_TOOL_ARGS_JSON:-$DEFAULT_ARGS_JSON}"

tmp_headers="$(mktemp)"
trap 'rm -f "$tmp_headers"' EXIT

init_body=$(
  cat <<JSON
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"$MCP_PROTOCOL_VERSION","capabilities":{},"clientInfo":{"name":"smoke_http_mcp","version":"0.0"}}}
JSON
)

curl -fsS -D "$tmp_headers" -o /tmp/mcp_init.json \
  -u "${MCP_BASIC_USER}:${MCP_BASIC_PASS}" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "x-mcp-bearer-token: ${MCP_PROJECT_TOKEN}" \
  -X POST "${MCP_BASE_URL}${MCP_PROJECT_PATH}" \
  -d "$init_body" >/dev/null

session_id="$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/{gsub(/\r/,"",$2); print $2}' "$tmp_headers")"
if [[ -z "$session_id" ]]; then
  echo "No mcp-session-id returned" >&2
  sed -n '1,120p' "$tmp_headers" >&2
  exit 3
fi

echo "initialize: ok (session=$session_id)"

tools_list_body='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
curl -fsS \
  -u "${MCP_BASIC_USER}:${MCP_BASIC_PASS}" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "mcp-protocol-version: ${MCP_PROTOCOL_VERSION}" \
  -H "mcp-session-id: ${session_id}" \
  -H "x-mcp-bearer-token: ${MCP_PROJECT_TOKEN}" \
  -X POST "${MCP_BASE_URL}${MCP_PROJECT_PATH}" \
  -d "$tools_list_body" >/dev/null

echo "tools/list: ok"

if [[ -n "${MCP_TOOL_NAME:-}" ]]; then
  call_body=$(
    cat <<JSON
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"$MCP_TOOL_NAME","arguments":$MCP_TOOL_ARGS_JSON}}
JSON
  )
  # Print response body on error to make debugging easier.
  call_out="$(mktemp)"
  if ! curl -fsS -o "$call_out" \
    -u "${MCP_BASIC_USER}:${MCP_BASIC_PASS}" \
    -H "content-type: application/json" \
    -H "accept: application/json, text/event-stream" \
    -H "mcp-protocol-version: ${MCP_PROTOCOL_VERSION}" \
    -H "mcp-session-id: ${session_id}" \
    -H "x-mcp-bearer-token: ${MCP_PROJECT_TOKEN}" \
    -X POST "${MCP_BASE_URL}${MCP_PROJECT_PATH}" \
    -d "$call_body"; then
    echo "tools/call: failed ($MCP_TOOL_NAME)" >&2
    sed -n '1,200p' "$call_out" >&2 || true
    rm -f "$call_out"
    exit 4
  fi
  rm -f "$call_out"
  echo "tools/call: ok ($MCP_TOOL_NAME)"
fi
