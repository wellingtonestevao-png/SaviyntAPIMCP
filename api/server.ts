import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSaviyntMcpServer } from "../src/saviynt-mcp-server.js";

interface VercelLikeRequest extends IncomingMessage {
  body?: unknown;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function getRequestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return req.url || "/";
  }
}

export default async function handler(req: VercelLikeRequest, res: ServerResponse): Promise<void> {
  const path = getRequestPath(req);
  if (path === "/" || path === "") {
    sendJson(res, 200, {
      ok: true,
      name: "saviynt-api-mcp",
      endpoints: {
        mcp: "/mcp",
        health: "/health",
        compatibleMcp: "/api/mcp",
        compatibleHealth: "/api/health",
      },
    });
    return;
  }

  if (
    path === "/health" ||
    path === "/health/" ||
    path === "/api/health" ||
    path === "/api/health/"
  ) {
    sendJson(res, 200, {
      ok: true,
      name: "saviynt-api-mcp",
      transport: "streamable-http",
      mode: "stateless",
    });
    return;
  }

  const server = createSaviyntMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    try {
      await transport.close();
    } catch {
      // Ignore close errors during cleanup.
    }

    try {
      await server.close();
    } catch {
      // Ignore close errors during cleanup.
    }
  };

  res.on("close", () => {
    void cleanup();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    sendJson(res, 500, {
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message,
      },
      id: null,
    });
    await cleanup();
  }
}
