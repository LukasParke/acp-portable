// `acp-portable serve`: speak ACP upstream (to Zed, JetBrains, T3, ...) and
// proxy to any ACP agent downstream. The backend is just a session config
// option ("Agent"), so a client can switch Claude -> Codex -> Pi mid-conversation
// and the conversation, MCP servers, mode and config preferences carry over.
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { ALIASES, loadRegistry } from "./agents.ts";
import type { Host } from "./backend.ts";
import { LocalCapabilities } from "./local-host.ts";
import { fromAcp, loadMcpConfig } from "./mcp.ts";
import { PortableSession } from "./portable.ts";
import { deleteConversation, listConversations, type Conversation } from "./transcript.ts";

const AGENT_OPTION = "acp_portable_agent";

export async function serve({ defaultAgent, mcpFiles, sharedMcp = false }: { defaultAgent: string; mcpFiles: string[]; sharedMcp?: boolean }) {
  const sessions = new Map<string, PortableSession>();
  const local = new LocalCapabilities();
  let upstream: acp.AgentContext;
  let clientCaps: acp.ClientCapabilities = {};
  const registry = await loadRegistry().catch(() => ({ agents: [] as { id: string; name: string }[] }));
  const agentChoices: acp.SessionConfigSelectOption[] = [
    ...Object.entries(ALIASES).filter(([k]) => ["claude", "codex", "pi"].includes(k)).map(([k, id]) => ({ value: k, name: registry.agents.find((a) => a.id === id)?.name ?? k })),
    ...registry.agents.map((a) => ({ value: a.id, name: a.name })),
  ];

  /** providers/set|disable from the client, applied to every current and future session. */
  const providerCalls = new Map<string, acp.SetProviderRequest | null>();
  const notify = (sessionId: string, update: acp.SessionUpdate) => upstream.notify("session/update", { sessionId, update });

  // Downstream agent -> upstream client, with the native session id swapped for the portable one.
  const hostFor = (portableId: string): Host => {
    const fwd = <M extends acp.ClientRequestMethod>(method: M, fallback: (p: never) => Promise<unknown>, supported: boolean) =>
      (params: { sessionId: string }) =>
        supported ? upstream.request(method, { ...params, sessionId: portableId } as never) : fallback(params as never);
    const fs = clientCaps.fs ?? {};
    const term = !!clientCaps.terminal;
    return {
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, elicitation: clientCaps.elicitation, session: clientCaps.session },
      update: () => {},
      requestPermission: fwd("session/request_permission", async () => ({ outcome: { outcome: "cancelled" } }), true) as Host["requestPermission"],
      readTextFile: fwd("fs/read_text_file", (p) => local.readTextFile(p), !!fs.readTextFile) as Host["readTextFile"],
      writeTextFile: fwd("fs/write_text_file", (p) => local.writeTextFile(p), !!fs.writeTextFile) as Host["writeTextFile"],
      createTerminal: fwd("terminal/create", (p) => local.createTerminal(p), term) as Host["createTerminal"],
      terminalOutput: fwd("terminal/output", (p) => local.terminalOutput(p), term) as Host["terminalOutput"],
      waitForTerminalExit: fwd("terminal/wait_for_exit", (p) => local.waitForTerminalExit(p), term) as Host["waitForTerminalExit"],
      killTerminal: fwd("terminal/kill", (p) => local.killTerminal(p), term) as Host["killTerminal"],
      releaseTerminal: fwd("terminal/release", (p) => local.releaseTerminal(p), term) as Host["releaseTerminal"],
      elicit: fwd("elicitation/create", async () => ({ action: "decline" }), !!clientCaps.elicitation) as Host["elicit"],
    };
  };

  const configOptions = (s: PortableSession): acp.SessionConfigOption[] => [
    { id: AGENT_OPTION, name: "Agent", description: "Backend coding agent (conversation carries over)", type: "select", currentValue: aliasOf(s.agentId!), options: agentChoices },
    ...(s.state.configOptions ?? []),
  ];
  const aliasOf = (id: string) => Object.entries(ALIASES).find(([k, v]) => v === id && ["claude", "codex", "pi"].includes(k))?.[0] ?? id;

  const commands = (s: PortableSession): acp.AvailableCommand[] => [
    { name: "agent", description: "Switch backend agent, keeping the conversation", input: { hint: "claude | codex | pi | <registry id>" } },
    ...s.state.commands.filter((c) => c.name !== "agent"),
  ];

  const sessionResult = (s: PortableSession) => ({ sessionId: s.conv.id, modes: s.state.modes, configOptions: configOptions(s) });

  const start = async (conv: Conversation | undefined, cwd: string, mcp: acp.McpServer[] | undefined, agent?: string) => {
    const s = conv
      ? PortableSession.open(conv.id, local as never)
      : PortableSession.create(cwd, { ...loadMcpConfig(cwd, mcpFiles), ...fromAcp(mcp) }, local as never);
    if (conv && mcp?.length) Object.assign(s.conv.mcpServers, fromAcp(mcp));
    s.host = hostFor(s.conv.id); // needs the portable id, which exists only after create/open
    for (const [id, call] of providerCalls) s.providers.set(id, call);
    // MCP-over-ACP servers the client provides are hosted in this process and reach every backend.
    for (const m of mcp ?? []) {
      if ("type" in m && m.type === "acp") await s.hub.addUpstream(m, (req) => upstream.request<acp.MessageMcpResponse>("mcp/message", req));
    }
    if (sharedMcp) await s.shareMcp();
    s.onUpdate = (u) => {
      if (u.sessionUpdate === "available_commands_update") u = { ...u, availableCommands: commands(s) };
      if (u.sessionUpdate === "config_option_update") u = { ...u, configOptions: configOptions(s) };
      void notify(s.conv.id, u);
    };
    sessions.set(s.conv.id, s);
    await switchAgent(s, agent ?? s.conv.entries.findLast((e) => e.t === "user")?.agent ?? defaultAgent, false);
    return s;
  };

  const switchAgent = async (s: PortableSession, spec: string, announce = true) => {
    await s.attach(spec);
    if (!announce) {
      setTimeout(() => void notify(s.conv.id, { sessionUpdate: "available_commands_update", availableCommands: commands(s) }), 0);
      return;
    }
    await notify(s.conv.id, { sessionUpdate: "config_option_update", configOptions: configOptions(s) });
    if (s.state.modes) await notify(s.conv.id, { sessionUpdate: "current_mode_update", currentModeId: s.state.modes.currentModeId });
    await notify(s.conv.id, { sessionUpdate: "available_commands_update", availableCommands: commands(s) });
  };

  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw acp.RequestError.resourceNotFound(id);
    return s;
  };

  /** Replay the portable transcript to the client (session/load semantics). */
  const replay = async (s: PortableSession) => {
    for (const e of s.conv.entries) {
      if (e.t === "user") for (const content of e.content) await notify(s.conv.id, { sessionUpdate: "user_message_chunk", content });
      if (e.t === "assistant") await notify(s.conv.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: e.text } });
      if (e.t === "thought") await notify(s.conv.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: e.text } });
      if (e.t === "tool") await notify(s.conv.id, { sessionUpdate: "tool_call", toolCallId: `${e.turn}-${e.id}`, title: e.title, kind: e.kind as acp.ToolKind, status: (e.status ?? "completed") as acp.ToolCallStatus, rawInput: e.input, content: e.output ? [{ type: "content", content: { type: "text", text: e.output } }] : [] });
      if (e.t === "plan") await notify(s.conv.id, { sessionUpdate: "plan", entries: e.entries.map((p) => ({ content: p.content, status: p.status as acp.PlanEntryStatus, priority: "medium" })) });
    }
  };

  const app = acp
    .agent({ name: "acp-portable" })
    .onRequest("initialize", ({ params, client }) => {
      upstream = client;
      clientCaps = params.clientCapabilities ?? {};
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "acp-portable", title: "ACP Portable", version: "0.1.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true }, // downgraded per backend
          mcpCapabilities: { http: true, sse: true, acp: true }, // bridged for backends without them
          sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {}, delete: {} },
          providers: {},
          auth: { logout: {} },
        },
        authMethods: [],
      };
    })
    .onRequest("session/new", async ({ params }) => sessionResult(await start(undefined, params.cwd, params.mcpServers)))
    .onRequest("session/load", async ({ params }) => {
      const conv = listConversations().find((c) => c.id === params.sessionId);
      if (!conv) throw acp.RequestError.resourceNotFound(params.sessionId);
      const s = sessions.get(conv.id) ?? (await start(conv, params.cwd, params.mcpServers));
      await replay(s);
      const { sessionId: _, ...rest } = sessionResult(s);
      return rest;
    })
    .onRequest("session/resume", async ({ params }) => {
      const conv = listConversations().find((c) => c.id === params.sessionId);
      if (!conv) throw acp.RequestError.resourceNotFound(params.sessionId);
      const s = sessions.get(conv.id) ?? (await start(conv, params.cwd, params.mcpServers));
      const { sessionId: _, ...rest } = sessionResult(s);
      return rest;
    })
    .onRequest("session/list", ({ params }) => ({
      sessions: listConversations(params.cwd ?? undefined).map((c) => ({ sessionId: c.id, cwd: c.cwd, title: c.title, updatedAt: c.updatedAt })),
    }))
    .onRequest("session/close", ({ params }) => {
      sessions.get(params.sessionId)?.dispose();
      sessions.delete(params.sessionId);
      return {};
    })
    .onRequest("session/delete", ({ params }) => {
      sessions.get(params.sessionId)?.dispose();
      sessions.delete(params.sessionId);
      deleteConversation(params.sessionId);
      return {};
    })
    // Provider routing is connection-wide in ACP: remember it and apply it to every backend that supports it.
    .onRequest("providers/list", async () => {
      const s = [...sessions.values()].findLast((x) => x.backend?.caps.providers);
      return { providers: s ? await s.listProviders() : [] };
    })
    .onRequest("providers/set", async ({ params }) => {
      providerCalls.set(params.providerId, params);
      for (const s of sessions.values()) await s.setProvider(params);
      return {};
    })
    .onRequest("providers/disable", async ({ params }) => {
      providerCalls.set(params.providerId, null);
      for (const s of sessions.values()) await s.disableProvider(params.providerId);
      return {};
    })
    .onRequest("logout", async () => {
      for (const s of sessions.values()) if (s.backend?.caps.auth?.logout) await s.logout();
      return {};
    })
    .onNotification("mcp/message", (p) => p as acp.MessageMcpNotification, ({ params }) => {
      for (const s of sessions.values()) s.hub.deliver(params);
    })
    .onRequest("session/set_mode", async ({ params }) => {
      await get(params.sessionId).setMode(params.modeId);
      return {};
    })
    .onRequest("session/set_config_option", async ({ params }) => {
      const s = get(params.sessionId);
      if (params.configId === AGENT_OPTION) await switchAgent(s, String(params.value));
      else await s.setConfig(params.configId, params.value as string | boolean);
      return { configOptions: configOptions(s) };
    })
    .onRequest("session/prompt", async ({ params }) => {
      const s = get(params.sessionId);
      const first = params.prompt[0];
      const m = first?.type === "text" ? first.text.match(/^\/agent\s+(\S+)\s*$/) : null;
      if (m) {
        await switchAgent(s, m[1]);
        await notify(s.conv.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Switched to ${s.backend!.displayName}. The conversation carries over.` } });
        return { stopReason: "end_turn" };
      }
      return await s.prompt(params.prompt);
    })
    .onNotification("session/cancel", async ({ params }) => {
      await sessions.get(params.sessionId)?.cancel();
    })
    .onRequest("session/fork", async ({ params }) => {
      const src = get(params.sessionId);
      const f = await src.fork();
      return sessionResult(await start(f.conv, params.cwd, params.mcpServers, src.agentId));
    });

  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const conn = app.connect(stream);
  await conn.closed;
  for (const s of sessions.values()) s.dispose();
}
