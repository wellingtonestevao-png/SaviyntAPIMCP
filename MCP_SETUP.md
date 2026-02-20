# Saviynt MCP Server Setup

## Transports
- `stdio` (best for Claude Desktop/local MCP clients)
- `http` with:
  - Streamable HTTP: `POST /mcp` (recommended modern MCP transport)
  - Legacy SSE: `GET /sse` + `POST /messages?sessionId=...`

## Run Locally

### 1) Build
```bash
npm run build
```

### 2) Start stdio transport
```bash
npm run start:stdio
```

### 3) Start HTTP transport
```bash
npm run start:http
```

Default URL: `http://127.0.0.1:3000`

## Quick HTTP Smoke Test
```bash
curl http://127.0.0.1:3000/health
```

Expected response:
```json
{"ok":true,"name":"saviynt-api-mcp","sessions":0}
```

## Claude Desktop (local stdio)

Add to Claude MCP config:

```json
{
  "mcpServers": {
    "saviynt": {
      "command": "node",
      "args": [
        "C:\\Users\\Wellington Estevao\\Documents\\VSSTudio\\SaviyntAPIMCP\\build\\index.js",
        "--transport=stdio"
      ],
      "env": {
        "SAVIYNT_BASE_URL": "https://YOUR-SAVIYNT-HOST",
        "SAVIYNT_ENABLE_WRITE": "false"
      }
    }
  }
}
```

## NPX-style Launch (local, stdio)

If you prefer `npx` style:

```json
{
  "mcpServers": {
    "saviynt": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "C:\\Users\\Wellington Estevao\\Documents\\VSSTudio\\SaviyntAPIMCP\\src\\index.ts",
        "--transport=stdio"
      ]
    }
  }
}
```

## Remote URL Bridge for stdio-only clients

If a client only supports stdio but you want to connect to an HTTP MCP URL:

```json
{
  "mcpServers": {
    "saviynt-remote": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:3000/mcp"
      ]
    }
  }
}
```

## Environment Variables
- `SAVIYNT_BASE_URL`: default Saviynt host (used when tool call does not pass `url`)
- `SAVIYNT_SERVICE_USERNAME`: service account username for stateless/serverless auth
- `SAVIYNT_SERVICE_PASSWORD`: service account password for stateless/serverless auth
- `SAVIYNT_USERNAME`: fallback alias for `SAVIYNT_SERVICE_USERNAME`
- `SAVIYNT_PASSWORD`: fallback alias for `SAVIYNT_SERVICE_PASSWORD`
- `SAVIYNT_API_PATH`: API path segment for typed tools (default `api/v5`)
- `SAVIYNT_ENABLE_WRITE`: set to `true` to enable write tools
- `SAVIYNT_MAX_RESULT_TEXT_CHARS`: max tool text payload before truncation (default `20000`)
- `SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS`: max full structured payload before summary fallback (default `4000`)
- `MCP_TRANSPORT`: optional default transport (`stdio` or `http`)
- `PORT` or `MCP_PORT`: HTTP port (default `3000`)
- `HOST`: bind host (default `127.0.0.1`)

## Deploy on Vercel

This repo includes `api/server.ts` and `vercel.json` for Vercel MCP hosting.

1. Import the repo into Vercel
2. Set these environment variables in Vercel:
   - `SAVIYNT_BASE_URL`
   - `SAVIYNT_SERVICE_USERNAME`
   - `SAVIYNT_SERVICE_PASSWORD`
   - `SAVIYNT_ENABLE_WRITE` (optional)
3. Deploy
4. Use:
   - MCP endpoint: `https://<your-project>.vercel.app/mcp`
   - Health endpoint: `https://<your-project>.vercel.app/health`

Note: Vercel function transport is configured as stateless. Prefer service-account env auth over runtime `saviynt_login` for reliable behavior across instances.
