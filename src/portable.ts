// A conversation that can move between ACP agents. The transcript is owned
// here, not by any agent: each agent gets a native session, and before every
// prompt it is sent whatever turns it has not seen yet (all of them for a
// fresh agent, only the delta for one that is resumed/loaded).
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { resolveAgent, type AgentCommand } from "./agents.ts";
import { Backend, type Host } from "./backend.ts";
import { fromAcp, toAcp, type PortableMcpServers } from "./mcp.ts";
import { McpHub } from "./mcp-hub.ts";
import { type Conversation, type Entry, currentTurn, newConversation, record, renderHandoff, saveConversation, loadConversation } from "./transcript.ts";

export type AgentState = {
  modes?: acp.SessionModeState | null;
  configOptions?: acp.SessionConfigOption[] | null;
  commands: acp.AvailableCommand[];
};

/** How the native session was obtained when attaching an agent. */
export type AttachKind = "new" | "resume" | "load";

const HANDOFF_PREAMBLE =
  "[acp-portable handoff] The user's message above continues a conversation that is portable across coding agents. " +
  "This transcript covers the turns you have not seen (they happened in another agent or session). Treat it as your " +
  "own prior context, do not redo completed work, and answer the user's message.";

export class PortableSession {
  conv: Conversation;
  backend?: Backend;
  sessionId?: string;
  state: AgentState = { commands: [] };
  /** Observers of live session updates (for rendering / proxying). */
  onUpdate: (u: acp.SessionUpdate, agentId: string) => void = () => {};
  host: Host;
  /** MCP servers hosted by acp-portable itself (MCP-over-ACP from upstream, or --shared-mcp). */
  hub = new McpHub();
  /** providers/set calls to replay on agents that support provider config (kept in memory: may hold secrets). */
  providers = new Map<string, acp.SetProviderRequest | null>();
  private turn = 0;
  private inTurn = false;
  private restartAfterTurn = false;
  private replay: "drop" | "import" | undefined;

  constructor(conv: Conversation, host: Host) {
    this.conv = conv;
    this.host = host;
  }

  static create(cwd: string, mcpServers: PortableMcpServers, host: Host) {
    const s = new PortableSession(newConversation(cwd, mcpServers), host);
    saveConversation(s.conv);
    return s;
  }

  static open(id: string, host: Host) {
    return new PortableSession(loadConversation(id), host);
  }

  get agentId(): string | undefined {
    return this.backend?.agent.id;
  }

  /** Host wrapper that records/filters updates belonging to the active native session. */
  private wrapHost(): Host {
    return {
      ...this.host,
      capabilities: this.host.capabilities,
      requestPermission: (r) => this.host.requestPermission(r),
      mcpMessage: (r) => this.hub.call(r),
      update: (n) => {
        if (n.sessionId !== this.sessionId || !this.backend) return;
        let u = n.update;
        if (u.sessionUpdate === "available_commands_update") this.state.commands = u.availableCommands;
        if (u.sessionUpdate === "current_mode_update" && this.state.modes) this.state.modes.currentModeId = u.currentModeId;
        if (u.sessionUpdate === "config_option_update") this.state.configOptions = u.configOptions;
        if (this.replay === "drop") return;
        if (this.replay === "import") return this.importUpdate(u);
        const u2 = stripAdapterNoise(this.backend.agent.id, u);
        if (!u2) return;
        u = u2;
        // Out-of-turn chatter (banners, late notices) is shown but not part of the transcript.
        if (this.inTurn) record(this.conv, this.turn, this.backend.agent.id, u);
        this.onUpdate(u, this.backend.agent.id);
      },
    };
  }

  /** Switch (or first attach) to an agent. The transcript travels with us. */
  async attach(spec: string | AgentCommand): Promise<AttachKind> {
    const agent = typeof spec === "string" ? await resolveAgent(spec) : spec;
    await this.start(agent);
    let kind: AttachKind;
    try {
      kind = await this.openNativeSession();
    } catch (e) {
      // env_var auth: relaunch the agent with the variables it asked for, then retry once.
      const env = await this.envForAuth(e);
      if (!env) throw e;
      await this.start({ ...agent, env: { ...agent.env, ...env } });
      const method = envVarMethods(this.backend!.init.authMethods)[0];
      if (method) await this.backend!.rpc.request("authenticate", { methodId: method.id }).catch(() => {});
      kind = await this.openNativeSession();
    }
    await this.applyPreferences();
    saveConversation(this.conv);
    return kind;
  }

  private async start(agent: AgentCommand) {
    this.detach();
    const env = applyQuirks(agent, this.conv.id, this.mcpFor({ http: true, sse: false }));
    const b = (this.backend = await Backend.start({ ...agent, env: { ...agent.env, ...env } }, this.wrapHost(), this.conv.cwd));
    this.hub.toAcpConsumer = b.caps.mcpCapabilities?.acp ? (n) => void b.rpc.notify("mcp/message", n) : undefined;
    await this.applyProviders();
  }

  /**
   * For auth_required with an `env_var` method (a draft ACP auth type several
   * agents ship): gather the listed variables from the agent's configured env,
   * this process's env, or the user (CLI), so the agent can be relaunched with them.
   */
  private async envForAuth(e: unknown): Promise<Record<string, string> | undefined> {
    if (!(e instanceof acp.RequestError) || e.code !== -32000) return;
    const b = this.backend!;
    for (const m of envVarMethods(b.init.authMethods)) {
      const env: Record<string, string> = {};
      for (const v of m.vars) {
        const value = b.agent.env[v.name] ?? process.env[v.name];
        if (value) env[v.name] = value;
      }
      if (Object.keys(env).length) return env;
      const asked = await this.host.collectEnv?.(b.agent.id, m);
      if (asked && Object.keys(asked).length) return asked;
    }
  }

  private async openNativeSession(): Promise<AttachKind> {
    const b = this.backend!;
    const link = this.conv.agents[b.agent.id];
    const base = { ...b.agent.sessionParams, cwd: this.conv.cwd, mcpServers: await this.mcpForAgent(b) };
    const set = (r: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null }) => {
      this.state = { modes: r.modes, configOptions: r.configOptions, commands: this.state.commands };
    };
    if (link) {
      this.sessionId = link.sessionId;
      try {
        if (b.caps.sessionCapabilities?.resume) {
          set(await withAuth(b, this.host, () => b.rpc.request("session/resume", { ...base, sessionId: link.sessionId })));
          return "resume";
        }
        if (b.caps.loadSession) {
          this.replay = "drop"; // we already have the history; ignore the replay
          set((await withAuth(b, this.host, () => b.rpc.request("session/load", { ...base, sessionId: link.sessionId }))) ?? {});
          return "load";
        }
      } catch (e) {
        process.stderr.write(`[acp-portable] could not reopen ${b.agent.id} session (${(e as Error).message}); starting fresh\n`);
      } finally {
        this.replay = undefined;
      }
    }
    const r: acp.NewSessionResponse = await withAuth(b, this.host, () => b.rpc.request("session/new", base));
    this.sessionId = r.sessionId;
    this.conv.agents[b.agent.id] = { sessionId: r.sessionId, syncedTurn: 0 };
    set(r);
    return "new";
  }

  /** Re-apply the user's last mode/config picks where the new agent offers the same ids and values. */
  private async applyPreferences() {
    const { mode } = this.conv.preferences;
    const config = { ...this.backend!.agent.defaults, ...this.conv.preferences.config };
    if (mode && mode !== this.state.modes?.currentModeId && this.state.modes?.availableModes.some((m) => m.id === mode)) {
      await this.setMode(mode).catch(() => {});
    }
    for (const [id, value] of Object.entries(config)) {
      const opt = this.state.configOptions?.find((o) => o.id === id);
      if (!opt || opt.currentValue === value) continue;
      const valid = opt.type === "boolean" ? typeof value === "boolean" : flatOptions(opt).some((o) => o.value === value);
      if (valid) await this.setConfig(id, value, id in this.conv.preferences.config).catch(() => {});
    }
  }

  /** MCP servers as this agent should see them: portable ones translated, hub-hosted ones bridged or over ACP. */
  mcpFor(caps: acp.McpCapabilities | undefined): acp.McpServer[] {
    const own = Object.fromEntries(Object.entries(this.conv.mcpServers).filter(([name]) => !this.hub.has(name)));
    return [...toAcp(own, caps), ...this.hub.entries(caps)];
  }

  /** mcpFor, plus stdio servers re-served over HTTP for agents that reject stdio MCP. */
  private async mcpForAgent(b: Backend): Promise<acp.McpServer[]> {
    const servers = this.mcpFor(b.caps.mcpCapabilities);
    if (!NO_STDIO_MCP.has(b.agent.id) || !b.caps.mcpCapabilities?.http) return servers;
    return Promise.all(servers.map(async (m): Promise<acp.McpServer> =>
      "command" in m ? { type: "http", name: m.name, url: await this.hub.httpUrl(m.name, { command: m.command, args: m.args, env: Object.fromEntries(m.env.map((e) => [e.name, e.value])) }), headers: [] } : m));
  }

  /** Host every portable MCP server in this process so all agents share one connection (and its state). */
  async shareMcp() {
    for (const [name, server] of Object.entries(this.conv.mcpServers)) if (!this.hub.has(name)) await this.hub.addLocal(name, server);
  }

  private async applyProviders() {
    const b = this.backend!;
    if (!b.caps.providers || this.providers.size === 0) return;
    for (const [providerId, set] of this.providers) {
      if (set) await b.rpc.request("providers/set", set).catch((e) => process.stderr.write(`[acp-portable] providers/set ${providerId}: ${e.message}\n`));
      else await b.rpc.request("providers/disable", { providerId }).catch(() => {});
    }
  }

  async listProviders(): Promise<acp.ProviderInfo[]> {
    const b = this.backend!;
    if (!b.caps.providers) throw new Error(`${b.agent.id} does not support providers/*`);
    return (await b.rpc.request("providers/list", {})).providers;
  }

  /** Route the agent's LLM traffic (base URL, api type, headers). Re-applied to every agent that supports it. */
  async setProvider(req: acp.SetProviderRequest) {
    this.providers.set(req.providerId, req);
    if (!this.backend?.caps.providers) return;
    await this.backend.rpc.request("providers/set", req);
    await this.reopen();
  }

  async disableProvider(providerId: string) {
    this.providers.set(providerId, null);
    if (!this.backend?.caps.providers) return;
    await this.backend.rpc.request("providers/disable", { providerId });
    await this.reopen();
  }

  /** Agents may drop live sessions when provider routing changes (claude-agent-acp does); reopen ours. */
  private async reopen() {
    await this.openNativeSession();
    saveConversation(this.conv);
  }

  async logout() {
    const b = this.backend!;
    if (!b.caps.auth?.logout) throw new Error(`${b.agent.id} does not support logout`);
    await b.rpc.request("logout", {});
  }

  /** Detach and stop hosting MCP servers; the session object is done. */
  dispose() {
    this.detach();
    this.hub.close();
  }

  detach() {
    const b = this.backend;
    if (b && this.sessionId && b.caps.sessionCapabilities?.close) void b.rpc.request("session/close", { sessionId: this.sessionId }).catch(() => {});
    b?.close();
    this.backend = undefined;
    this.sessionId = undefined;
    this.state = { commands: [] };
  }

  /** Turns this agent hasn't seen, rendered as a handoff document (empty if fully synced). */
  pendingHandoff(): string {
    const b = this.backend!;
    const link = this.conv.agents[b.agent.id];
    const names = Object.fromEntries(Object.keys(this.conv.agents).map((id) => [id, id]));
    return renderHandoff(this.conv, link?.syncedTurn ?? 0, names);
  }

  async prompt(content: string | acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const b = this.backend;
    if (!b || !this.sessionId) throw new Error("no agent attached");
    const blocks: acp.ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const handoff = this.pendingHandoff();
    this.turn = currentTurn(this.conv) + 1;
    this.conv.entries.push({ t: "user", turn: this.turn, agent: b.agent.id, content: blocks });
    if (!this.conv.title) this.conv.title = blocks.map((x) => (x.type === "text" ? x.text : "")).join(" ").slice(0, 80);
    // Images/audio the user sent in unseen turns travel as real blocks, not just "[image]" in the text.
    const link = this.conv.agents[b.agent.id];
    const media = this.conv.entries.filter((e): e is Extract<Entry, { t: "user" }> => e.t === "user" && e.turn > (link?.syncedTurn ?? 0) && e.turn < this.turn)
      .flatMap((e) => e.content.filter((c) => (c.type === "image" && b.caps.promptCapabilities?.image) || (c.type === "audio" && b.caps.promptCapabilities?.audio)));
    // The handoff goes inline, after the user's own text: some harnesses (dirac) read only the
    // first text block and drop embedded resources even when they advertise embeddedContext.
    const prompt = adaptPrompt(handoff ? withHandoff(blocks, `${HANDOFF_PREAMBLE}\n\n<transcript>\n${handoff}\n</transcript>`, media) : blocks, b.caps.promptCapabilities);
    this.inTurn = true;
    try {
      const res = await withAuth(b, this.host, () => b.rpc.request("session/prompt", { sessionId: this.sessionId!, prompt }));
      this.conv.entries.push({ t: "stop", turn: this.turn, agent: b.agent.id, stopReason: res.stopReason });
      this.conv.agents[b.agent.id].syncedTurn = this.turn;
      return res;
    } finally {
      this.inTurn = false;
      saveConversation(this.conv);
      if (this.restartAfterTurn) {
        // The agent reported "cancelled" but may still be generating; restart it and reopen the session.
        this.restartAfterTurn = false;
        await this.start(b.agent);
        await this.openNativeSession();
      }
    }
  }

  async cancel() {
    if (!this.backend || !this.sessionId) return;
    await this.backend.rpc.notify("session/cancel", { sessionId: this.sessionId });
    if (HARD_CANCEL.has(this.backend.agent.id)) this.restartAfterTurn = true;
  }

  async setMode(modeId: string) {
    const b = this.backend!;
    await b.rpc.request("session/set_mode", { sessionId: this.sessionId!, modeId });
    if (this.state.modes) this.state.modes.currentModeId = modeId;
    this.conv.preferences.mode = modeId;
    saveConversation(this.conv);
  }

  async setConfig(configId: string, value: string | boolean, remember = true) {
    const b = this.backend!;
    const params = typeof value === "boolean"
      ? { sessionId: this.sessionId!, configId, type: "boolean" as const, value }
      : { sessionId: this.sessionId!, configId, value };
    const r = await b.rpc.request("session/set_config_option", params as acp.SetSessionConfigOptionRequest);
    this.state.configOptions = r.configOptions;
    if (remember) this.conv.preferences.config[configId] = value;
    saveConversation(this.conv);
  }

  /**
   * Fork: a new portable conversation with the same history. When the current
   * agent supports session/fork its native session is forked too, so that agent
   * continues without a handoff; every other agent re-syncs from the transcript.
   */
  async fork(): Promise<PortableSession> {
    const copy = newConversation(this.conv.cwd, this.conv.mcpServers);
    copy.entries = structuredClone(this.conv.entries);
    copy.preferences = structuredClone(this.conv.preferences);
    copy.title = this.conv.title && `${this.conv.title} (fork)`;
    const b = this.backend;
    const link = b && this.conv.agents[b.agent.id];
    if (b && link && b.caps.sessionCapabilities?.fork) {
      const r = await b.rpc.request("session/fork", { ...b.agent.sessionParams, sessionId: link.sessionId, cwd: this.conv.cwd, mcpServers: this.mcpFor(b.caps.mcpCapabilities) });
      copy.agents[b.agent.id] = { sessionId: r.sessionId, syncedTurn: link.syncedTurn };
    }
    saveConversation(copy);
    return new PortableSession(copy, this.host);
  }

  async deleteNative(sessionId: string) {
    const b = this.backend!;
    if (!b.caps.sessionCapabilities?.delete) throw new Error(`${b.agent.id} does not support session/delete`);
    await b.rpc.request("session/delete", { sessionId });
  }

  /** List the agent's own native sessions (session/list), e.g. ones started in its own UI. */
  async listNative(): Promise<acp.SessionInfo[]> {
    const b = this.backend!;
    if (!b.caps.sessionCapabilities?.list) throw new Error(`${b.agent.id} does not support session/list`);
    const r = await b.rpc.request("session/list", { cwd: this.conv.cwd });
    return r.sessions;
  }

  /**
   * Pull a native session (e.g. started in Claude Code's own UI) into this
   * portable conversation via session/load, capturing the replayed history.
   */
  async importNative(sessionId: string) {
    const b = this.backend!;
    if (!b.caps.loadSession) throw new Error(`${b.agent.id} does not support session/load`);
    this.sessionId = sessionId;
    this.turn = currentTurn(this.conv);
    this.replay = "import";
    try {
      const r = await b.rpc.request("session/load", { ...b.agent.sessionParams, cwd: this.conv.cwd, mcpServers: this.mcpFor(b.caps.mcpCapabilities), sessionId });
      this.state = { ...this.state, modes: r?.modes, configOptions: r?.configOptions };
    } finally {
      this.replay = undefined;
    }
    for (const e of this.conv.entries) if (e.turn > 0 && !this.conv.entries.some((x) => x.t === "stop" && x.turn === e.turn)) {
      this.conv.entries.push({ t: "stop", turn: e.turn, agent: b.agent.id, stopReason: "end_turn" });
    }
    this.conv.entries.sort((a, b2) => a.turn - b2.turn);
    this.conv.agents[b.agent.id] = { sessionId, syncedTurn: currentTurn(this.conv) };
    saveConversation(this.conv);
  }

  private importUpdate(u: acp.SessionUpdate) {
    const agent = this.backend!.agent.id;
    if (u.sessionUpdate === "user_message_chunk") {
      const last = this.conv.entries[this.conv.entries.length - 1];
      if (last?.t === "user" && last.turn === this.turn) last.content.push(u.content);
      else this.conv.entries.push({ t: "user", turn: ++this.turn, agent, content: [u.content] } as Entry);
      return;
    }
    record(this.conv, this.turn, agent, u);
  }
}

/**
 * Remove adapter-injected text that isn't part of the conversation. Before its
 * first reply pi-acp emits, as a separate chunk, either an npm "New version
 * available" notice or a whole startup block ("pi vX\n---\n## Skills ..."),
 * with no opt-out. Returns undefined when nothing is left of the update.
 */
const PI_UPDATE_NOTICE = /^New version available: v[\d.]+ \(installed v[\d.]+\)\. Run: `npm i -g [^`]+`\n?/;
const PI_STARTUP_BLOCK = /^pi v[\d.]+\n---\n[\s\S]*$/;
function stripAdapterNoise(agentId: string, u: acp.SessionUpdate): acp.SessionUpdate | undefined {
  if (agentId !== "pi-acp" || u.sessionUpdate !== "agent_message_chunk" || u.content.type !== "text") return u;
  const text = u.content.text.replace(PI_STARTUP_BLOCK, "").replace(PI_UPDATE_NOTICE, "");
  if (text === u.content.text) return u;
  return text ? { ...u, content: { ...u.content, text } } : undefined;
}

/**
 * Agents whose session/cancel doesn't reliably stop generation: pi-acp answers
 * "cancelled" but, if the model hadn't started streaming yet, pi keeps going and
 * the output leaks into the next turn. For these the process is restarted after
 * a cancelled turn and the native session reopened (session/load).
 */
const HARD_CANCEL = new Set(["pi-acp"]);

/** Agents that refuse stdio MCP servers (spec says all must accept them); they get local HTTP endpoints instead. */
const NO_STDIO_MCP = new Set(["dimcode"]);

/** Draft-ACP `env_var` auth methods: the client launches the agent with these variables set. */
export type EnvVarMethod = { id: string; name: string; vars: { name: string; label?: string; optional?: boolean; secret?: boolean }[] };
function envVarMethods(methods: acp.AuthMethod[] | undefined): EnvVarMethod[] {
  return (methods ?? []).filter((m) => (m as { type?: string }).type === "env_var") as unknown as EnvVarMethod[];
}

function flatOptions(o: acp.SessionConfigOption): acp.SessionConfigSelectOption[] {
  if (o.type !== "select") return [];
  return o.options.flatMap((x) => ("options" in x ? x.options : [x]));
}

/**
 * On auth_required, authenticate and retry once. Agent-handled methods are
 * called directly; terminal methods run the agent binary with the method's
 * args/env interactively (when the host has a terminal), then retry.
 */
async function withAuth<T>(b: Backend, host: Host, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (!(e instanceof acp.RequestError) || e.code !== -32000) throw e;
    const methods = b.init.authMethods ?? [];
    const agentMethod = methods.find((m) => !("type" in m) || m.type == null || (m.type as string) === "agent");
    const term = methods.find((m): m is acp.AuthMethodTerminal & { type: "terminal" } => "type" in m && m.type === "terminal");
    if (agentMethod) {
      await b.rpc.request("authenticate", { methodId: agentMethod.id });
    } else if (term && host.runTerminalAuth) {
      await host.runTerminalAuth({ ...b.agent, args: [...b.agent.args, ...(term.args ?? [])], env: { ...b.agent.env, ...(term.env ?? {}) } }, term.name);
    } else {
      const hint = term ? `run \`${b.agent.command} ${[...b.agent.args, ...(term.args ?? [])].join(" ")}\` in a terminal to log in` : "log in with the agent's own CLI";
      throw new Error(`${b.agent.id}: authentication required — ${hint}`);
    }
    return await op();
  }
}

/** Append the handoff to the user's first text block (or add one), followed by any carried-over media. */
function withHandoff(blocks: acp.ContentBlock[], handoff: string, media: acp.ContentBlock[]): acp.ContentBlock[] {
  const i = blocks.findIndex((b) => b.type === "text");
  const out = [...blocks];
  if (i >= 0) out[i] = { ...(out[i] as acp.TextContent & { type: "text" }), text: `${(out[i] as { text: string }).text}\n\n${handoff}` };
  else out.unshift({ type: "text", text: handoff });
  return [...out, ...media];
}

/** Downgrade content an agent can't accept (embedded resources -> text, images -> placeholder). */
function adaptPrompt(blocks: acp.ContentBlock[], caps: acp.PromptCapabilities | undefined): acp.ContentBlock[] {
  return blocks.map((b): acp.ContentBlock => {
    if (b.type === "resource" && !caps?.embeddedContext) {
      return { type: "text", text: "text" in b.resource ? `<file uri="${b.resource.uri}">\n${b.resource.text}\n</file>` : `[attached ${b.resource.uri}]` };
    }
    if (b.type === "image" && !caps?.image) return { type: "text", text: `[image${b.uri ? ` ${b.uri}` : ""} omitted: agent has no image support]` };
    if (b.type === "audio" && !caps?.audio) return { type: "text", text: "[audio omitted: agent has no audio support]" };
    return b;
  });
}

/**
 * Per-agent shims for adapters that don't yet honour parts of ACP.
 * pi-acp ignores `mcpServers` in session/new, but Pi reads MCP servers from
 * $PI_CODING_AGENT_DIR/mcp.json, so we give it an overlay agent dir that links
 * the user's real Pi config and adds the portable servers.
 */
function applyQuirks(agent: AgentCommand, convId: string, servers: acp.McpServer[]): Record<string, string> {
  if (agent.id !== "pi-acp" || servers.length === 0) return {};
  const real = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const overlay = join(homedir(), ".cache", "acp-portable", "pi-overlay", convId);
  rmSync(overlay, { recursive: true, force: true });
  mkdirSync(overlay, { recursive: true });
  for (const f of existsSync(real) ? readdirSync(real) : []) if (f !== "mcp.json") symlinkSync(join(real, f), join(overlay, f));
  const userMcp = existsSync(join(real, "mcp.json")) ? JSON.parse(readFileSync(join(real, "mcp.json"), "utf8")).mcpServers ?? {} : {};
  // Computed for Pi's transports (stdio + streamable HTTP); SSE and hub servers arrive as stdio bridges.
  const ours = fromAcp(servers);
  writeFileSync(join(overlay, "mcp.json"), JSON.stringify({ mcpServers: { ...userMcp, ...ours } }, null, 2));
  return { PI_CODING_AGENT_DIR: overlay };
}
