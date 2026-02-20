# Saviynt API MCP Server

MCP server for Saviynt APIs with:
- `stdio` transport for desktop MCP clients (Claude Desktop, etc.)
- HTTP transport with Streamable HTTP (`/mcp`) and SSE compatibility (`/sse`, `/messages`)
- Vercel serverless Streamable HTTP endpoint (`/mcp`) via `api/server.ts`

The server includes login/session token handling, read tools, workflow write tools, and generic create/modify/delete tools.

## Requirements

- Node.js 18+
- npm

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Run

```bash
# stdio (best for Claude Desktop/local MCP)
npm run start:stdio

# HTTP server (Streamable HTTP + SSE compatibility)
npm run start:http
```

Dev scripts:

```bash
npm run dev:stdio
npm run dev:http
```

## Transports

When running HTTP mode, default bind is `http://127.0.0.1:3000`.

- Streamable HTTP endpoint: `POST /mcp`
- Legacy SSE endpoints:
  - `GET /sse`
  - `POST /messages?sessionId=...`
- Health: `GET /health`

## Environment Variables

- `SAVIYNT_BASE_URL`: default Saviynt base URL
- `SAVIYNT_SERVICE_USERNAME`: optional service account username for stateless/serverless mode
- `SAVIYNT_SERVICE_PASSWORD`: optional service account password for stateless/serverless mode
- `SAVIYNT_USERNAME`: fallback alias for `SAVIYNT_SERVICE_USERNAME`
- `SAVIYNT_PASSWORD`: fallback alias for `SAVIYNT_SERVICE_PASSWORD`
- `SAVIYNT_API_PATH`: API path segment used by typed tools (default `api/v5`)
- `SAVIYNT_ENABLE_WRITE`: `true` to enable write tools (default is disabled)
- `SAVIYNT_MAX_RESULT_TEXT_CHARS`: max size of tool text response before truncation (default `20000`)
- `SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS`: max size for full `structuredContent` before summary fallback (default `4000`)
- `MCP_TRANSPORT`: optional default transport (`stdio` or `http`)
- `PORT` or `MCP_PORT`: HTTP port (default `3000`)
- `HOST`: HTTP host (default `127.0.0.1`)

## Authentication Flow

1. Call `saviynt_login` (or `login`) with:
   - `username`
   - `password`
   - optional `url` (Saviynt base URL override)
2. Server obtains and caches a bearer token for the current MCP session.
3. Token refresh is automatic on expiry/401.

For serverless/stateless deployments (for example Vercel), set `SAVIYNT_SERVICE_USERNAME` and
`SAVIYNT_SERVICE_PASSWORD` so tools can authenticate without relying on in-memory session login state.

Check auth status with `saviynt_get_token_status` (or `get_token_status`).

## Deploy to Vercel

This repo includes:
- `api/server.ts`: Vercel function entrypoint for MCP Streamable HTTP (stateless transport)
- `vercel.json`: rewrites `/mcp` and `/health` to the Vercel function

Steps:
1. Import this repo into Vercel.
2. Set environment variables in Vercel project settings:
   - `SAVIYNT_BASE_URL`
   - `SAVIYNT_SERVICE_USERNAME`
   - `SAVIYNT_SERVICE_PASSWORD`
   - `SAVIYNT_ENABLE_WRITE` (`true`/`false`)
3. Deploy.
4. Use your MCP URL:
   - `https://<your-project>.vercel.app/mcp`
   - Health check: `https://<your-project>.vercel.app/health`

## Tool List

### Authentication
- `saviynt_login`
- `login`
- `saviynt_get_token_status`
- `get_token_status`

### Read Tools
- `saviynt_query_identities`
- `saviynt_get_user_profile`
- `saviynt_search_users`
- `saviynt_get_accounts`
- `saviynt_get_entitlements`
- `saviynt_search_access_requests`
- `saviynt_list_applications`
- `saviynt_list_endpoints`
- `saviynt_search_security_systems`
- `saviynt_get_accounts_import_details`
- `saviynt_get_access_import_details`
- `saviynt_get_import_job_status`
- `saviynt_get_audit_log`
- `saviynt_get_system_config`
- `saviynt_list_roles`
- `saviynt_list_campaigns`

### Compatibility Read Aliases
- `get_users`
- `get_user_accounts`
- `get_user_entitlements`
- `get_user_roles`
- `get_user_endpoints`
- `get_complete_access_path`
- `get_list_of_pending_requests_for_approver`

### Write Tools (require `SAVIYNT_ENABLE_WRITE=true`)

Workflow writes:
- `saviynt_create_access_request`
- `saviynt_approve_request`
- `saviynt_reject_request`
- `saviynt_revoke_access`
- `approve_reject_entire_request`

Typed Saviynt v5 writes (from Chicago API reference):
- `saviynt_create_user`
- `saviynt_update_user`
- `saviynt_create_account`
- `saviynt_update_account`
- `saviynt_add_role`
- `saviynt_remove_role`
- `saviynt_create_endpoint`
- `saviynt_update_endpoint`
- `saviynt_create_security_system`
- `saviynt_update_security_system`
- `saviynt_create_organization`
- `saviynt_update_organization`
- `saviynt_delete_organization`
- `saviynt_create_update_entitlement`
- `saviynt_create_entitlement_type`
- `saviynt_update_entitlement_type`
- `saviynt_create_update_user_group`
- `saviynt_delete_user_group`
- `saviynt_create_dataset`
- `saviynt_update_dataset`
- `saviynt_delete_dataset`

Generic CRUD writes:
- `saviynt_create_resource`
- `create_resource` (alias)
- `saviynt_modify_resource`
- `modify_resource` (alias)
- `saviynt_delete_resource`
- `delete_resource` (alias)

Raw API access:
- `saviynt_raw_request`
- `raw_request` (alias)

## Generic CRUD Examples

Create:

```json
{
  "tool": "saviynt_create_resource",
  "arguments": {
    "endpoint": "/ECM/api/yourCreateEndpoint",
    "body": {
      "name": "example"
    }
  }
}
```

Modify:

```json
{
  "tool": "saviynt_modify_resource",
  "arguments": {
    "endpoint": "/ECM/api/yourUpdateEndpoint",
    "method": "PATCH",
    "body": {
      "id": "123",
      "status": "ACTIVE"
    }
  }
}
```

Delete:

```json
{
  "tool": "saviynt_delete_resource",
  "arguments": {
    "endpoint": "/ECM/api/yourDeleteEndpoint",
    "method": "DELETE",
    "params": {
      "id": "123"
    }
  }
}
```

## Claude Desktop Example

Use stdio transport:

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
        "SAVIYNT_BASE_URL": "https://your-saviynt-host",
        "SAVIYNT_ENABLE_WRITE": "false"
      }
    }
  }
}
```

For a URL bridge pattern, see `MCP_SETUP.md`.

## Notes

- If you share your exact Saviynt API spec/endpoints, this server can be extended with strongly typed create/update/delete tools (for users, roles, endpoints, applications, etc.) instead of only generic CRUD wrappers.
