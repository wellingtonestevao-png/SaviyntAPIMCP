import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSaviyntMcpServer } from "./saviynt-mcp-server.js";

export async function startStdioServer(): Promise<void> {
  const server = createSaviyntMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Saviynt MCP server started on stdio transport");
}

