// Reference / conformance ACP agent. Deterministic, no LLM. It exercises the
// client side of ACP so acp-portable's host and proxy paths can be verified:
//   * every prompt: reports the content block types it received and whether a
//     handoff was attached, then calls tools on every `type: "acp"` MCP server
//     (it advertises `mcpCapabilities.acp`, which no released agent does yet)
//   * prompt "conformance": plan, thought, tool call + permission, fs write/read,
//     terminal create/wait/output/release, elicitation, mode/config/title/usage
//     updates, slash commands
//   * prompt "slow": streams until session/cancel, then stops with "cancelled"
// Capabilities come from env REF_CAPS (JSON, merged into promptCapabilities) and
// REF_NAME, so tests can run two differently-shaped instances.
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk/unstable";

const name = process.env.REF_NAME ?? "ref-agent";
const promptCaps = { image: true, audio: true, embeddedContext: true, ...JSON.parse(process.env.REF_CAPS ?? "{}") };
type Session = { mcp: acp.McpServer[]; mode: string; model: string; cancelled?: () => void };
const sessions = new Map<string, Session>();
let next = 0;
let loggedOut = false;

const modes = (s: Session): acp.SessionModeState => ({ currentModeId: s.mode, availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] });
const config = (s: Session): acp.SessionConfigOption[] => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] },
];
const session = (id: string) => {
  const s = sessions.get(id);
  if (!s) throw acp.RequestError.resourceNotFound(id);
  return s;
};

const app = acp
  .agent({ name })
  .onRequest("initialize", ({ params }) => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name, version: "1.0.0" },
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { acp: true },
      promptCapabilities: promptCaps,
      sessionCapabilities: { resume: {}, close: {} },
      auth: { logout: {} },
      _meta: { clientCapabilities: params.clientCapabilities },
    },
    authMethods: [],
  }))
  .onRequest("logout", () => {
    loggedOut = true;
    return {};
  })
  .onRequest("session/new", ({ params }) => {
    const sessionId = randomUUID();
    const s: Session = { mcp: params.mcpServers, mode: "ask", model: "small" };
    sessions.set(sessionId, s);
    return { sessionId, modes: modes(s), configOptions: config(s) };
  })
  .onRequest("session/resume", ({ params }) => {
    const s = session(params.sessionId);
    s.mcp = params.mcpServers ?? s.mcp;
    return { modes: modes(s), configOptions: config(s) };
  })
  .onRequest("session/close", ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onRequest("session/set_mode", async ({ params, client }) => {
    session(params.sessionId).mode = params.modeId;
    await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId } });
    return {};
  })
  .onRequest("session/set_config_option", ({ params }) => {
    const s = session(params.sessionId);
    if (params.configId === "model") s.model = String(params.value);
    return { configOptions: config(s) };
  })
  .onNotification("session/cancel", ({ params }) => sessions.get(params.sessionId)?.cancelled?.())
  .onRequest("session/prompt", async ({ params, client }) => {
    const s = session(params.sessionId);
    const sid = params.sessionId;
    const up = (update: acp.SessionUpdate) => client.notify("session/update", { sessionId: sid, update });
    const say = (text: string) => up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    const handoff = params.prompt.some((b) => (b.type === "resource" && b.resource.uri.includes("handoff")) || (b.type === "text" && b.text.includes("[acp-portable handoff]")));
    const handoffText = params.prompt.map((b) => (b.type === "resource" && "text" in b.resource ? b.resource.text : b.type === "text" ? b.text : "")).join("\n");
    await say(`${name}: blocks=${params.prompt.map((b) => b.type).join(",")} handoff=${handoff} reasoningInHandoff=${handoffText.includes("### Reasoning")} mode=${s.mode} model=${s.model} loggedOut=${loggedOut}\n`);

    if (/\bslow\b/.test(text)) {
      const cancelled = new Promise<void>((r) => (s.cancelled = r));
      for (let i = 0; i < 200; i++) {
        const stop = await Promise.race([cancelled.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 50))]);
        if (stop) return { stopReason: "cancelled" };
        await say(".");
      }
      return { stopReason: "end_turn" };
    }

    if (/\bconformance\b/.test(text)) {
      const results: Record<string, string> = {};
      await up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about conformance" } });
      await up({ sessionUpdate: "plan", entries: [{ content: "write file", priority: "high", status: "in_progress" }, { content: "run command", priority: "medium", status: "pending" }] });
      await up({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "ref", description: "reference command" }] });
      await up({ sessionUpdate: "session_info_update", title: "Conformance run" });
      const path = `${process.env.REF_DIR ?? "/tmp"}/ref-agent-${sid}.txt`;
      await up({ sessionUpdate: "tool_call", toolCallId: "t1", title: `Write ${path}`, kind: "edit", status: "pending", locations: [{ path }] });
      const perm = await client.request("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: "t1", title: `Write ${path}` },
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }],
      });
      results.permission = perm.outcome.outcome === "selected" ? perm.outcome.optionId : "cancelled";
      await client.request("fs/write_text_file", { sessionId: sid, path, content: "line1\nline2\nline3" });
      results.fs = (await client.request("fs/read_text_file", { sessionId: sid, path, line: 2, limit: 1 })).content;
      await up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path, oldText: null, newText: "line1\nline2\nline3" }] });
      await up({ sessionUpdate: "tool_call", toolCallId: "t2", title: "echo", kind: "execute", status: "in_progress" });
      const { terminalId } = await client.request("terminal/create", { sessionId: sid, command: "echo", args: ["term-ok"] });
      const exit = await client.request("terminal/wait_for_exit", { sessionId: sid, terminalId });
      results.terminal = `${(await client.request("terminal/output", { sessionId: sid, terminalId })).output.trim()} exit=${exit.exitCode}`;
      await client.request("terminal/release", { sessionId: sid, terminalId });
      await up({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [{ type: "terminal", terminalId }] });
      const el = await client.request("elicitation/create", { sessionId: sid, mode: "form", message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] } } as acp.CreateElicitationRequest);
      results.elicitation = el.action === "accept" ? `accept:${JSON.stringify((el as { content?: unknown }).content)}` : el.action;
      await up({ sessionUpdate: "usage_update", used: 1234, size: 200000 } as acp.SessionUpdate);
      await say(`RESULTS ${JSON.stringify(results)}\n`);
    }

    for (const srv of s.mcp.filter((m): m is acp.McpServerAcp & { type: "acp" } => "type" in m && m.type === "acp")) {
      const call = async (method: string, p: Record<string, unknown> = {}) => {
        const r = await client.request<acp.MessageMcpResponse>("mcp/message", { serverId: srv.serverId, requestId: `ref-${++next}`, method, params: p });
        if ("error" in r && r.error) throw new Error(`${method}: ${r.error.message}`);
        return (r as { result: any }).result;
      };
      await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
      for (const t of (await call("tools/list")).tools) {
        const r = await call("tools/call", { name: t.name, arguments: {} });
        await say(`${srv.name}.${t.name} -> ${r.content.map((c: { text?: string }) => c.text).join("")}\n`);
      }
    }
    return { stopReason: "end_turn" };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
