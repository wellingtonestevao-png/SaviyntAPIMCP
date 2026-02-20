# Saviynt MCP Setup

This project is a Vercel-hosted MCP server using Streamable HTTP.

## Transport and Endpoints

- Transport: Streamable HTTP
- MCP endpoint: `POST /mcp`
- Health endpoint: `GET /health`
- Compatibility aliases:
  - MCP: `/api/mcp`
  - Health: `/api/health`

Base URL example:
- `https://saviynt-apimcp.vercel.app/mcp`

## Deploy

1. Install dependencies:
```bash
npm install
```

2. Validate types:
```bash
npm run build
```

3. Deploy to Vercel:
```bash
vercel
```

## Required and Optional Environment Variables

Required for write tools:
- `SAVIYNT_ENABLE_WRITE` (`true` or `false`)

Optional:
- `SAVIYNT_API_PATH` (default: `api/v5`)
- `SAVIYNT_MAX_RESULT_TEXT_CHARS` (default: `20000`)
- `SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS` (default: `4000`)

Optional for environment-based auth profile:
- `SAVIYNT_BASE_URL`
- `SAVIYNT_SERVICE_USERNAME`
- `SAVIYNT_SERVICE_PASSWORD`

## Authentication Model

The server supports two patterns.

1. Runtime profile auth (recommended for testing with multiple tenants):
- Use `saviynt_upsert_profile` with `profileId`, `username`, `password`, `url`.
- Optionally switch default profile with `saviynt_set_active_profile`.
- Pass `profileId` in tool calls when needed.

2. Environment default profile:
- Configure `SAVIYNT_BASE_URL`, `SAVIYNT_SERVICE_USERNAME`, `SAVIYNT_SERVICE_PASSWORD`.
- Server auto-creates `env-default` profile.

Token behavior:
- Bearer tokens are cached in-memory per `profileId + baseUrl`.
- On Vercel serverless, cache can reset between invocations.

## Claude Configuration

If your Claude client supports URL MCP servers directly:

```json
{
  "mcpServers": {
    "saviynt-vercel": {
      "url": "https://saviynt-apimcp.vercel.app/mcp"
    }
  }
}
```

If your Claude client expects stdio command, use `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "saviynt-vercel": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://saviynt-apimcp.vercel.app/mcp"
      ]
    }
  }
}
```

## Quick Test Flow

1. Check health:
```bash
curl https://saviynt-apimcp.vercel.app/health
```

2. In Claude, call:
- `saviynt_upsert_profile`
- `saviynt_get_token_status`
- `saviynt_get_user_profile`

Example profile setup call:

```json
{
  "tool": "saviynt_upsert_profile",
  "arguments": {
    "profileId": "lab",
    "username": "admin",
    "password": "your-password",
    "url": "https://your-tenant.saviyntcloud.com",
    "setActive": true,
    "authenticate": true
  }
}
```

## Troubleshooting

Server starts then disconnects:
- Confirm MCP path is `/mcp` (not `/`).
- Confirm Claude config points to `https://.../mcp`.

Responses too large:
- Use tighter filters and limits.
- Lower response limits with:
  - `SAVIYNT_MAX_RESULT_TEXT_CHARS`
  - `SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS`

Auth errors:
- Call `saviynt_get_token_status` and confirm active profile.
- Re-run `saviynt_upsert_profile` with correct URL and credentials.
