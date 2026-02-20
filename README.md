# Saviynt API MCP Server

Vercel-only MCP server for Saviynt APIs using Streamable HTTP transport.

This project is configured for remote MCP clients through a URL endpoint, not local stdio transport.

## Endpoints

- MCP: `POST /mcp`
- Health: `GET /health`
- Compatibility aliases:
  - MCP: `/api/mcp`
  - Health: `/api/health`

Configured by:
- `api/server.ts`
- `vercel.json`

## Requirements

- Node.js 18+
- npm
- Vercel account/project

## Install

```bash
npm install
```

## Validate Types

```bash
npm run build
```

## Local Vercel Dev

```bash
npm run dev
```

Default local URL from Vercel dev is typically `http://127.0.0.1:3000`.

## Deploy to Vercel

1. Import this repo into Vercel (or run `vercel` from CLI).
2. Set project environment variables:
   - `SAVIYNT_BASE_URL`
   - `SAVIYNT_SERVICE_USERNAME`
   - `SAVIYNT_SERVICE_PASSWORD`
   - `SAVIYNT_ENABLE_WRITE` (`true` or `false`)
   - optional: `SAVIYNT_API_PATH` (default `api/v5`)
   - optional: `SAVIYNT_MAX_RESULT_TEXT_CHARS` (default `20000`)
   - optional: `SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS` (default `4000`)
3. Deploy.
4. Use:
   - `https://<your-project>.vercel.app/mcp`
   - `https://<your-project>.vercel.app/health`

## Authentication Model

Recommended for Vercel/serverless:
- Use `SAVIYNT_SERVICE_USERNAME` + `SAVIYNT_SERVICE_PASSWORD` + `SAVIYNT_BASE_URL`.
- Server acquires and refreshes bearer tokens during requests.

The tools `saviynt_login` / `login` still exist for compatibility, but should not be the primary auth method in stateless multi-instance deployments.

Check current auth state with:
- `saviynt_get_token_status`
- `get_token_status`

## Response Size Limits

Large Saviynt payloads can exceed MCP client limits. This server truncates oversized responses:

- `SAVIYNT_MAX_RESULT_TEXT_CHARS`: text payload cap (default `20000`)
- `SAVIYNT_MAX_STRUCTURED_CONTENT_CHARS`: structured content cap (default `4000`)

For large datasets, use tighter filters, limits, and pagination.

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

Typed Saviynt v5 writes:
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

## MCP Client URL Config Example

```json
{
  "mcpServers": {
    "saviynt": {
      "url": "https://<your-project>.vercel.app/mcp"
    }
  }
}
```

Saved client templates:
- `examples/claude_desktop_config.mcp-remote.json`
- `examples/claude_code.mcp.json`
