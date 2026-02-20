# Saviynt MCP Setup (Vercel Only)

This project is configured for remote MCP usage over Streamable HTTP on Vercel.

## Endpoints

- MCP: `https://<your-project>.vercel.app/mcp`
- Health: `https://<your-project>.vercel.app/health`
- Compatibility aliases:
  - MCP: `https://<your-project>.vercel.app/api/mcp`
  - Health: `https://<your-project>.vercel.app/api/health`

## 1) Install and Validate

```bash
npm install
npm run build
```

## 2) Configure Vercel Environment Variables

Required:
- `SAVIYNT_BASE_URL`
- `SAVIYNT_SERVICE_USERNAME`
- `SAVIYNT_SERVICE_PASSWORD`

Optional:
- `SAVIYNT_ENABLE_WRITE` (`true`/`false`)
- `SAVIYNT_API_PATH` (default `api/v5`)
- `SAVIYNT_MAX_RESULT_TEXT_CHARS` (default `20000`)
- `SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS` (default `4000`)

## 3) Deploy

Using Vercel dashboard:
- Import this GitHub repo and deploy

Using CLI:

```bash
vercel
vercel --prod
```

## 4) Verify

Health check:

```bash
curl https://<your-project>.vercel.app/health
```

Expected:

```json
{"ok":true,"name":"saviynt-api-mcp","transport":"streamable-http","mode":"stateless"}
```

## 5) MCP Client Configuration Example

```json
{
  "mcpServers": {
    "saviynt": {
      "url": "https://<your-project>.vercel.app/mcp"
    }
  }
}
```

## Authentication Notes

- Preferred in Vercel: service-account environment credentials.
- `saviynt_login` still exists for compatibility, but do not rely on it for persistence in stateless/multi-instance serverless runtime.
