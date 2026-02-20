import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createSaviyntMcpServer } from "./saviynt-mcp-server.js";

type SessionTransport = StreamableHTTPServerTransport | SSEServerTransport;

interface SessionState {
  transport: SessionTransport;
  server: McpServer;
  protocol: "streamable" | "sse";
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

function headerAsString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function startHttpServer(): void {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.PORT || process.env.MCP_PORT || "3000", 10);
  const app = createMcpExpressApp({ host });
  const sessions: Record<string, SessionState> = {};

  const cleanupSession = async (sessionId: string): Promise<void> => {
    const session = sessions[sessionId];
    if (!session) {
      return;
    }
    delete sessions[sessionId];

    try {
      await session.transport.close();
    } catch {
      // Ignore close errors during cleanup.
    }

    try {
      await session.server.close();
    } catch {
      // Ignore close errors during cleanup.
    }
  };

  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = headerAsString(req.headers["mcp-session-id"]);
      if (sessionId) {
        const existing = sessions[sessionId];
        if (!existing) {
          jsonRpcError(res, 400, "Bad Request: Unknown session ID");
          return;
        }

        if (existing.protocol !== "streamable") {
          jsonRpcError(
            res,
            400,
            "Bad Request: Session exists but uses a different transport protocol"
          );
          return;
        }

        await (existing.transport as StreamableHTTPServerTransport).handleRequest(req, res, req.body);
        return;
      }

      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, "Bad Request: No valid session ID provided");
        return;
      }

      const server = createSaviyntMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          sessions[initializedSessionId] = {
            transport,
            server,
            protocol: "streamable",
          };
        },
      });

      transport.onclose = () => {
        const closedSessionId = transport.sessionId;
        if (closedSessionId) {
          void cleanupSession(closedSessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      if (!res.headersSent) {
        jsonRpcError(res, 500, message);
      }
    }
  });

  app.get("/sse", async (req: Request, res: Response) => {
    try {
      const server = createSaviyntMcpServer();
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;

      sessions[sessionId] = {
        transport,
        server,
        protocol: "sse",
      };

      res.on("close", () => {
        void cleanupSession(sessionId);
      });

      await server.connect(transport);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to initialize SSE session";
      if (!res.headersSent) {
        res.status(500).send(message);
      }
    }
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const rawSessionId = req.query.sessionId;
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    if (!sessionId) {
      res.status(400).send("Missing sessionId parameter");
      return;
    }

    const session = sessions[sessionId];
    if (!session) {
      res.status(404).send("Session not found");
      return;
    }

    if (session.protocol !== "sse") {
      jsonRpcError(res, 400, "Bad Request: Session exists but uses a different transport protocol");
      return;
    }

    try {
      await (session.transport as SSEServerTransport).handlePostMessage(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to process message";
      if (!res.headersSent) {
        res.status(500).send(message);
      }
    }
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      name: "saviynt-api-mcp",
      sessions: Object.keys(sessions).length,
    });
  });

  const listener = app.listen(port, host, () => {
    console.error(`[MCP] HTTP server listening on http://${host}:${port}`);
    console.error("[MCP] Streamable HTTP endpoint: /mcp");
    console.error("[MCP] Legacy SSE endpoints: GET /sse, POST /messages?sessionId=...");
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    console.error(`[MCP] ${signal} received, shutting down...`);
    listener.close();

    const sessionIds = Object.keys(sessions);
    for (const sessionId of sessionIds) {
      await cleanupSession(sessionId);
    }

    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

