#!/usr/bin/env node
// Tiny MCP server used to prove MCP portability: the `get_codeword` tool
// returns a secret the model cannot know unless the MCP connection works.
// stdio by default; `--http <port>` serves streamable HTTP, `--sse <port>` legacy SSE.
// Replies include this process's pid and a call counter, so tests can tell
// whether agents share one server instance.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const codeword = process.env.CODEWORD ?? "PORTABLE-PLATYPUS";
const log = process.env.CODEWORD_LOG;
const tool = process.env.CODEWORD_TOOL ?? "get_codeword";
let calls = 0;

function build() {
  const server = new McpServer({ name: "codeword", version: "1.0.0" });
  server.registerTool(tool, { description: "Returns today's secret codeword." }, async () => {
    calls++;
    if (log) appendFileSync(log, `${new Date().toISOString()} ${tool} pid=${process.pid} call=${calls}\n`);
    return { content: [{ type: "text", text: `${codeword} (instance ${process.pid}, call ${calls})` }] };
  });
  return server;
}

const httpPort = process.argv.indexOf("--http");
if (httpPort > 0) {
  const port = Number(process.argv[httpPort + 1] ?? 8765);
  createServer(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await build().connect(transport);
    await transport.handleRequest(req, res);
  }).listen(port, () => console.error(`codeword MCP on http://127.0.0.1:${port}/mcp`));
} else if (process.argv.includes("--sse")) {
  const port = Number(process.argv[process.argv.indexOf("--sse") + 1] ?? 8766);
  const transports = new Map<string, SSEServerTransport>();
  createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (req.method === "GET" && url.pathname === "/sse") {
      const t = new SSEServerTransport("/messages", res);
      transports.set(t.sessionId, t);
      res.on("close", () => transports.delete(t.sessionId));
      await build().connect(t);
    } else if (req.method === "POST" && url.pathname === "/messages") {
      const t = transports.get(url.searchParams.get("sessionId") ?? "");
      if (t) await t.handlePostMessage(req, res);
      else res.writeHead(404).end();
    } else res.writeHead(404).end();
  }).listen(port, () => console.error(`codeword MCP (sse) on http://127.0.0.1:${port}/sse`));
} else {
  await build().connect(new StdioServerTransport());
}
