// End-to-end: drive `acp-portable serve` as an ordinary ACP client would, and
// move one conversation across agents (default: claude -> codex -> pi -> claude).
//   node test/e2e.ts [agent ...]
// Each agent must (1) know a fact only stated to the first agent and (2) call
// three MCP servers: streamable HTTP, legacy SSE, and one provided by this
// client over ACP itself (MCP-over-ACP, `mcp/message`). Then: list/load/fork,
// and a --shared-mcp run proving agents reuse one MCP server instance.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const agents = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "codex", "pi", "claude"];
const dir = mkdtempSync(join(tmpdir(), "acpp-e2e-"));
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const httpWord = `HTTP-${rnd()}`;
const sseWord = `SSE-${rnd()}`;
const clientWord = `ACP-${rnd()}`;
const fact = `ZEBRA-${Math.floor(Math.random() * 9000 + 1000)}`;
const port = 18000 + Math.floor(Math.random() * 1000);
let failures = 0;

const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${what}`);
  if (!ok) failures++;
};
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);

const children: ChildProcess[] = [];
async function mcpServer(mode: "--http" | "--sse", p: number, word: string, tool: string, log: string) {
  const c = spawn(process.execPath, [join(root, "examples/codeword-mcp.ts"), mode, String(p)], {
    env: { ...process.env, CODEWORD: word, CODEWORD_TOOL: tool, CODEWORD_LOG: log },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(c);
  await new Promise((r) => c.stderr!.once("data", r));
}
const httpLog = join(dir, "http.log");
const sseLog = join(dir, "sse.log");
await mcpServer("--http", port, httpWord, "get_codeword", httpLog);
await mcpServer("--sse", port + 1, sseWord, "get_sse_codeword", sseLog);
const httpUrl = `http://127.0.0.1:${port}/mcp`;
const sseUrl = `http://127.0.0.1:${port + 1}/sse`;

// --- 1. bridges, no LLM involved ----------------------------------------------------------
for (const [kind, url, tool, word] of [["http", httpUrl, "get_codeword", httpWord], ["sse", sseUrl, "get_sse_codeword", sseWord]]) {
  const client = new Client({ name: "bridge-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "src/mcp-bridge.ts"), kind, url] }));
  const r = (await client.callTool({ name: tool, arguments: {} })) as { content: { text: string }[] };
  check(r.content[0].text.startsWith(word), `mcp-bridge forwards stdio MCP to a ${kind} server`);
  await client.close();
}

// --- an MCP server that lives in this ACP client and is reached over ACP (mcp/message) --
let clientCalls = 0;
function clientMcp(req: acp.MessageMcpRequest): acp.MessageMcpResponse {
  switch (req.method) {
    case "initialize":
      return { result: { protocolVersion: (req.params as { protocolVersion?: string })?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "client-tools", version: "1" } } };
    case "tools/list":
      return { result: { tools: [{ name: "get_client_secret", description: "Returns a secret held by the ACP client.", inputSchema: { type: "object", properties: {} } }] } };
    case "tools/call":
      clientCalls++;
      return { result: { content: [{ type: "text", text: clientWord }] } };
    case "ping":
      return { result: {} };
    default:
      return { error: { code: -32601, message: `unsupported ${req.method}` } };
  }
}

type Run = { agent: acp.ClientContext; sessionId: string; ask: (p: string, sessionId?: string) => Promise<string> };
async function withServe(args: string[], mcpServers: acp.McpServer[], body: (r: Run) => Promise<void>) {
  const server = spawn(process.execPath, [join(root, "src/cli.ts"), "serve", ...args], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
  children.push(server);
  const stream = acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>);
  let text = "";
  const app = acp
    .client({ name: "e2e" })
    .onNotification("session/update", ({ params }) => {
      const u = params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
      if (u.sessionUpdate === "user_message_chunk") replayed++;
    })
    .onRequest("session/request_permission", ({ params }) => {
      permissions++;
      const o = params.options.find((x) => x.kind === "allow_always") ?? params.options.find((x) => x.kind === "allow_once")!;
      return { outcome: { outcome: "selected", optionId: o.optionId } };
    })
    .onRequest("mcp/message", (p) => p as acp.MessageMcpRequest, ({ params }) => clientMcp(params));
  await app.connectWith(stream, async (agent) => {
    const init = await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    check(init.agentInfo?.name === "acp-portable" && !!init.agentCapabilities?.mcpCapabilities?.acp, "serve: initialize (advertises mcp:acp)");
    const s = await agent.request("session/new", { cwd: dir, mcpServers });
    const ask = async (prompt: string, sessionId = s.sessionId) => {
      text = "";
      await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
      return text;
    };
    await body({ agent, sessionId: s.sessionId, ask });
  });
  server.kill();
}

let replayed = 0;
let permissions = 0;
const switchTo = async ({ agent, sessionId, ask }: Run, name: string, i: number) => {
  // alternate between the two switching mechanisms ACP clients can use
  if (i % 2) await agent.request("session/set_config_option", { sessionId, configId: "acp_portable_agent", value: name });
  else check((await ask(`/agent ${name}`)).includes("Switched"), `/agent ${name} command`);
};

// --- 2. serve mode, multi-agent ------------------------------------------------------------
const mcpServers: acp.McpServer[] = [
  { type: "http", name: "codeword", url: httpUrl, headers: [] },
  { type: "sse", name: "ssecodeword", url: sseUrl, headers: [] },
  { type: "acp", name: "clienttools", serverId: "e2e-client-tools" },
];
await withServe([], mcpServers, async (run) => {
  const { agent, sessionId, ask } = run;
  for (const [i, name] of agents.entries()) {
    const before = { http: lines(httpLog).length, sse: lines(sseLog).length, acp: clientCalls };
    if (i > 0) await switchTo(run, name, i);
    const tools = "Call these three MCP tools yourself: get_codeword (server codeword), get_sse_codeword (server ssecodeword), get_client_secret (server clienttools).";
    const prompt = i === 0
      ? `Remember this fact for later in our chat: the launch password is ${fact}. ${tools} Reply on one line: "a=<codeword> b=<sse codeword> c=<client secret>".`
      : `${tools} Reply on one line: "a=<codeword> b=<sse codeword> c=<client secret> password=<the launch password I told you earlier>".`;
    const text = await ask(prompt);
    console.log(`  [${name}] ${text.trim().split("\n").slice(-1)[0].slice(0, 220)}`);
    check(text.includes(httpWord) && lines(httpLog).length > before.http, `${name}: called the streamable-HTTP MCP server`);
    check(text.includes(sseWord) && lines(sseLog).length > before.sse, `${name}: called the SSE MCP server`);
    check(text.includes(clientWord) && clientCalls > before.acp, `${name}: called the client-provided MCP-over-ACP server`);
    if (i > 0) check(text.includes(fact), `${name}: recalls the fact told to ${agents[0]} (portable history)`);
  }

  const list = await agent.request("session/list", { cwd: dir });
  check(list.sessions.some((x) => x.sessionId === sessionId), "session/list returns the portable conversation");

  const fork = await agent.request("session/fork", { sessionId, cwd: dir, mcpServers });
  const forkConv = JSON.parse(readFileSync(join(homedir(), ".acp-portable", "conversations", `${fork.sessionId}.json`), "utf8"));
  const last = Object.entries(forkConv.agents as Record<string, { sessionId: string; syncedTurn: number }>);
  check(fork.sessionId !== sessionId && last.length === 1 && last[0][1].syncedTurn === agents.length, `session/fork: new conversation with natively forked ${last[0]?.[0]} session (synced to turn ${last[0]?.[1].syncedTurn})`);
  const forkText = await ask("No tools. What is the launch password? Reply with just the password.", fork.sessionId);
  check(forkText.includes(fact), `fork continues on ${last[0]?.[0]} without a handoff and still knows the password`);

  await agent.request("session/close", { sessionId });
  replayed = 0;
  await agent.request("session/load", { sessionId, cwd: dir, mcpServers: [] });
  check(replayed >= agents.length, `session/load replays the cross-agent transcript (${replayed} user messages)`);
  await agent.request("session/delete", { sessionId: fork.sessionId });
  check(!(await agent.request("session/list", { cwd: dir })).sessions.some((x) => x.sessionId === fork.sessionId), "session/delete removes the fork");
  console.log(`  (permission requests forwarded to this client: ${permissions})`);
});

// --- 3. --shared-mcp: one MCP server instance reused across agent switches ----------------
const sharedLog = join(dir, "shared.log");
const shared: acp.McpServer[] = [{
  name: "shared",
  command: process.execPath,
  args: [join(root, "examples/codeword-mcp.ts")],
  env: [{ name: "CODEWORD", value: httpWord }, { name: "CODEWORD_TOOL", value: "get_shared_codeword" }, { name: "CODEWORD_LOG", value: sharedLog }],
}];
const pair = [...new Set(agents)].slice(0, 2);
await withServe(["--shared-mcp", "--agent", pair[0]], shared, async (run) => {
  for (const [i, name] of pair.entries()) {
    if (i > 0) await switchTo(run, name, i);
    const text = await run.ask("Call the get_shared_codeword tool (server shared) and reply with its full output verbatim.");
    console.log(`  [${name}] ${text.trim().split("\n").slice(-1)[0].slice(0, 160)}`);
  }
  const pids = new Set(lines(sharedLog).map((l) => l.match(/pid=(\d+)/)?.[1]));
  check(lines(sharedLog).length >= pair.length && pids.size === 1, `--shared-mcp: ${pair.join(" and ")} used one MCP server process (${lines(sharedLog).length} calls, pids ${[...pids].join(",")})`);
});

children.forEach((c) => c.kill());
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
