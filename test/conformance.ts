// Protocol conformance of acp-portable's host + proxy paths, no LLM: drives
// `serve` with backends built from test/ref-agent.ts.
//   node test/conformance.ts
// 1. client-side methods are forwarded to an upstream client that has them
//    (permission, fs, terminal, elicitation) and every update kind reaches it
// 2. with a capability-less client they fall back to the local machine
// 3. modes, config options, cancellation, logout
// 4. prompt content is downgraded for agents lacking image/embeddedContext,
//    and a handoff (with reasoning) reaches a second, differently-shaped agent
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk/unstable";

const root = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${what}`);
  if (!ok) failures++;
};
const ref = (env: Record<string, string>) => `cmd:env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")} ${process.execPath} ${join(root, "test/ref-agent.ts")}`;

type Client = { agent: acp.ClientContext; sessionId: string; text: () => string; updates: acp.SessionUpdate[]; calls: string[]; vfs: Map<string, string> };
async function withServe(dir: string, agentSpec: string, caps: acp.ClientCapabilities, body: (c: Client) => Promise<void>) {
  const server = spawn(process.execPath, [join(root, "src/cli.ts"), "serve", "--agent", agentSpec], { cwd: dir, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, REF_DIR: dir } });
  const stream = acp.ndJsonStream(Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>);
  let text = "";
  const updates: acp.SessionUpdate[] = [];
  const calls: string[] = [];
  const vfs = new Map<string, string>();
  const app = acp
    .client({ name: "conformance" })
    .onNotification("session/update", ({ params }) => {
      updates.push(params.update);
      if (params.update.sessionUpdate === "agent_message_chunk" && params.update.content.type === "text") text += params.update.content.text;
    })
    .onRequest("session/request_permission", ({ params }) => {
      calls.push("permission");
      return { outcome: { outcome: "selected", optionId: params.options.find((o) => o.kind === "allow_once")!.optionId } };
    })
    .onRequest("fs/write_text_file", ({ params }) => (calls.push("fs/write"), vfs.set(params.path, params.content), {}))
    .onRequest("fs/read_text_file", ({ params }) => {
      calls.push("fs/read");
      const lines = (vfs.get(params.path) ?? "").split("\n");
      const start = (params.line ?? 1) - 1;
      return { content: lines.slice(start, params.limit ? start + params.limit : undefined).join("\n") };
    })
    .onRequest("terminal/create", () => (calls.push("terminal/create"), { terminalId: "client-term" }))
    .onRequest("terminal/wait_for_exit", () => (calls.push("terminal/wait"), { exitCode: 0, signal: null }))
    .onRequest("terminal/output", () => (calls.push("terminal/output"), { output: "from-upstream-terminal", truncated: false, exitStatus: { exitCode: 0, signal: null } }))
    .onRequest("terminal/release", () => (calls.push("terminal/release"), {}))
    .onRequest("terminal/kill", () => ({}))
    .onRequest("elicitation/create", () => (calls.push("elicitation"), { action: "accept", content: { name: "Ada" } } as acp.CreateElicitationResponse));
  await app.connectWith(stream, async (agent) => {
    await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: caps });
    const s = await agent.request("session/new", { cwd: dir, mcpServers: [] });
    await body({ agent, sessionId: s.sessionId, text: () => text, updates, calls, vfs });
    text = "";
  });
  server.kill();
}
const prompt = (c: Client, ...blocks: acp.ContentBlock[]) => c.agent.request("session/prompt", { sessionId: c.sessionId, prompt: blocks });
const results = (t: string) => JSON.parse(t.match(/RESULTS (\{.*\})/)?.[1] ?? "{}");

// --- 1. forwarding to a full-featured upstream client ---------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "acpp-conf-"));
  const full: acp.ClientCapabilities = { fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: { form: {} } };
  await withServe(dir, ref({ REF_NAME: "ref-a" }), full, async (c) => {
    await prompt(c, { type: "text", text: "conformance" });
    const r = results(c.text());
    check(r.permission === "yes" && c.calls.includes("permission"), "session/request_permission forwarded upstream");
    check(r.fs === "line2" && c.calls.includes("fs/write") && c.calls.includes("fs/read") && [...c.vfs.keys()].length === 1, "fs/write_text_file + fs/read_text_file (line/limit) forwarded upstream");
    check(r.terminal === "from-upstream-terminal exit=0" && ["terminal/create", "terminal/wait", "terminal/output", "terminal/release"].every((m) => c.calls.includes(m)), "terminal/* forwarded upstream");
    check(r.elicitation === 'accept:{"name":"Ada"}' && c.calls.includes("elicitation"), "elicitation/create forwarded upstream");
    const kinds = new Set(c.updates.map((u) => u.sessionUpdate));
    const want = ["agent_thought_chunk", "plan", "tool_call", "tool_call_update", "session_info_update", "usage_update", "available_commands_update", "agent_message_chunk"];
    check(want.every((k) => kinds.has(k as acp.SessionUpdate["sessionUpdate"])), `all update kinds reach the client (${want.filter((k) => kinds.has(k as never)).length}/${want.length})`);
    const cmds = c.updates.findLast((u) => u.sessionUpdate === "available_commands_update") as { availableCommands: acp.AvailableCommand[] } | undefined;
    check(!!cmds && ["agent", "ref"].every((n) => cmds.availableCommands.some((x) => x.name === n)), "slash commands: agent's own + /agent");

    // modes & config options
    await c.agent.request("session/set_mode", { sessionId: c.sessionId, modeId: "code" });
    const cfg = await c.agent.request("session/set_config_option", { sessionId: c.sessionId, configId: "model", value: "large" });
    check(cfg.configOptions.some((o) => o.id === "model" && o.currentValue === "large") && cfg.configOptions.some((o) => o.id === "acp_portable_agent"), "session/set_config_option forwarded; Agent option kept alongside");
    const before = c.text().length;
    await prompt(c, { type: "text", text: "status" });
    check(/mode=code model=large/.test(c.text().slice(before)), "session/set_mode + model reached the agent");

    // cancellation
    const slow = prompt(c, { type: "text", text: "slow" });
    await new Promise((r) => setTimeout(r, 400));
    await c.agent.notify("session/cancel", { sessionId: c.sessionId });
    check((await slow).stopReason === "cancelled", "session/cancel stops a running turn (stopReason=cancelled)");

    // logout
    await c.agent.request("logout", {});
    const b2 = c.text().length;
    await prompt(c, { type: "text", text: "status" });
    check(c.text().slice(b2).includes("loggedOut=true"), "logout forwarded to the backend");
  });
}

// --- 2. local fallback for a client without fs/terminal/elicitation --------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "acpp-conf-"));
  await withServe(dir, ref({ REF_NAME: "ref-b" }), {}, async (c) => {
    await prompt(c, { type: "text", text: "conformance" });
    const r = results(c.text());
    const file = join(dir, `ref-agent-${(c.updates.find((u) => u.sessionUpdate === "tool_call") as { title: string }).title.match(/ref-agent-(.*)\.txt/)?.[1]}.txt`);
    check(r.fs === "line2" && existsSync(file) && readFileSync(file, "utf8") === "line1\nline2\nline3" && c.calls.length === 1, "fs falls back to the local disk when the client lacks it");
    check(r.terminal === "term-ok exit=0", "terminal falls back to a local process");
    check(r.elicitation === "decline", "elicitation declined when the client can't present it");
  });
}

// --- 3. content downgrade + handoff between differently-shaped agents ------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "acpp-conf-"));
  const rich = ref({ REF_NAME: "rich" });
  const plain = ref({ REF_NAME: "plain", REF_CAPS: '{"image":false,"audio":false,"embeddedContext":false}' });
  await withServe(dir, rich, {}, async (c) => {
    const blocks: acp.ContentBlock[] = [
      { type: "text", text: "conformance" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      { type: "resource", resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# notes" } },
      { type: "resource_link", uri: "file:///x.ts", name: "x.ts" },
    ];
    await prompt(c, ...blocks);
    check(/rich: blocks=text,image,resource,resource_link handoff=false/.test(c.text()), "rich agent receives image + embedded resource as-is");
    await c.agent.request("session/set_config_option", { sessionId: c.sessionId, configId: "acp_portable_agent", value: plain });
    const before = c.text().length;
    await prompt(c, ...blocks);
    const line = c.text().slice(before);
    check(/plain: blocks=text,text,text,resource_link handoff=true/.test(line), `plain agent gets image/resource downgraded to text, plus the handoff inline (${line.split("\n")[0].slice(0, 90)})`);
    check(line.includes("reasoningInHandoff=true"), "handoff carries the previous agent's visible reasoning");
  });
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
