// MCP-over-ACP provider side, no LLM: an upstream client provides an MCP
// server over ACP and --shared-mcp hosts a stdio server; acp-portable serve
// must expose both to a backend that consumes `type: "acp"` servers
// (test/ref-agent.ts), routing its `mcp/message` calls to the right provider.
//   node test/mcp-over-acp.ts
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk/unstable";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "acpp-mcpacp-"));
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${what}`);
  if (!ok) failures++;
};

const ref = `cmd:${process.execPath} ${join(root, "test/ref-agent.ts")}`;
const server = spawn(process.execPath, [join(root, "src/cli.ts"), "serve", "--shared-mcp", "--agent", ref], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>);
const seen: string[] = [];
let text = "";
const app = acp
  .client({ name: "mcp-acp-test" })
  .onNotification("session/update", ({ params }) => {
    if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") text += params.update.content.text;
  })
  .onRequest("mcp/message", (p) => p as acp.MessageMcpRequest, ({ params }): acp.MessageMcpResponse => {
    seen.push(params.method);
    if (params.method === "initialize") return { result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "upstream", version: "1" } } };
    if (params.method === "tools/list") return { result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }] } };
    if (params.method === "tools/call") return { result: { content: [{ type: "text", text: "UPSTREAM-CLIENT-TOOL" }] } };
    return { error: { code: -32601, message: params.method } };
  });

await app.connectWith(stream, async (agent) => {
  await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const s = await agent.request("session/new", {
    cwd: dir,
    mcpServers: [
      { type: "acp", name: "upstream", serverId: "up-1" },
      { name: "shared", command: process.execPath, args: [join(root, "examples/codeword-mcp.ts")], env: [{ name: "CODEWORD", value: "SHARED-STDIO" }] },
    ],
  });
  await agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] });
  console.log(text.trim().replace(/^/gm, "  "));
  check(text.includes("upstream.whoami -> UPSTREAM-CLIENT-TOOL") && seen.includes("tools/call"), "backend's mcp/message calls reached the upstream client's server (proxied)");
  check(text.includes("shared.get_codeword -> SHARED-STDIO"), "backend's mcp/message calls reached the stdio server hosted by acp-portable");
  check(!seen.includes("notifications/initialized"), "only inner requests cross the ACP carrier");
});
server.kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
