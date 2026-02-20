import { startHttpServer } from "./http-server.js";
import { startStdioServer } from "./stdio-server.js";

type TransportMode = "stdio" | "http";

function resolveTransportMode(): TransportMode {
  const arg = process.argv.find((value) => value.startsWith("--transport="));
  if (arg) {
    const value = arg.split("=")[1]?.toLowerCase();
    if (value === "http") {
      return "http";
    }
    return "stdio";
  }

  if (process.argv.includes("--http")) {
    return "http";
  }

  const fromEnv = process.env.MCP_TRANSPORT?.toLowerCase();
  if (fromEnv === "http") {
    return "http";
  }

  return "stdio";
}

async function main(): Promise<void> {
  const mode = resolveTransportMode();

  if (mode === "http") {
    startHttpServer();
    return;
  }

  await startStdioServer();
}

main().catch((error) => {
  console.error("[MCP] Failed to start server:", error);
  process.exit(1);
});

