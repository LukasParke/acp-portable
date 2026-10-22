#!/usr/bin/env node
// stdio MCP bridge, launched as an agent's stdio MCP server:
//   node mcp-bridge.ts <http|sse> <url>   forward to a streamable-HTTP / SSE server
//                                         (for agents lacking that transport)
//   node mcp-bridge.ts unix <socket>      pipe into acp-portable's MCP hub
//                                         (MCP-over-ACP and shared servers)
import { connect } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const [transport, target] = process.argv.slice(2);

if (transport === "unix") {
  const sock = connect(target);
  process.stdin.pipe(sock).pipe(process.stdout);
  sock.on("close", () => process.exit(0));
  sock.on("error", (e) => {
    process.stderr.write(`[mcp-bridge] ${e}\n`);
    process.exit(1);
  });
} else {
  const headers = JSON.parse(process.env.ACP_PORTABLE_MCP_HEADERS || "{}");
  const requestInit = { headers };
  const remote = transport === "sse"
    ? new SSEClientTransport(new URL(target), { requestInit, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...headers, ...(init?.headers as object) } }) } })
    : new StreamableHTTPClientTransport(new URL(target), { requestInit });
  const local = new StdioServerTransport();

  local.onmessage = (m) => remote.send(m).catch((e) => process.stderr.write(`[mcp-bridge] send failed: ${e}\n`));
  remote.onmessage = (m) => local.send(m);
  remote.onerror = (e) => process.stderr.write(`[mcp-bridge] ${e}\n`);
  remote.onclose = () => process.exit(0);
  local.onclose = () => remote.close().finally(() => process.exit(0));

  await remote.start();
  await local.start();
}
