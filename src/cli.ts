#!/usr/bin/env node
// acp-portable: one conversation, any ACP agent.
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ALIASES, loadRegistry } from "./agents.ts";
import { loadMcpConfig } from "./mcp.ts";
import { PortableSession } from "./portable.ts";
import { TerminalHost } from "./terminal-host.ts";
import { listConversations, loadConversation, renderHandoff } from "./transcript.ts";

const HELP = `acp-portable — portable conversations across ACP agents

usage:
  acp-portable [chat] [--agent claude] [--resume <id>]   interactive chat
  acp-portable run --agent <a> [--resume <id>] <prompt>  one turn, prints conversation id
  acp-portable serve [--agent claude]                    act as an ACP agent (for Zed, etc.)
  acp-portable import --agent <a> <native-session-id>    pull an agent-native session in
  acp-portable list | show <id> | agents

agents: claude, codex, pi, any ACP registry id (gemini, opencode, goose, ...),
        or a raw command line ("my-agent --acp"). Launched via Ori when available.
options: --mcp <file> (extra mcpServers json), --shared-mcp (one MCP connection shared by all agents),
         --cwd <dir>, --yolo (auto-approve),
         --thoughts (show reasoning), --mode <id>, --set <configId>=<value>

chat commands:
  /agent <a>   switch agent, conversation carries over   /agents  list agents
  /status      agent, session, sync state                /mcp     portable MCP servers
  /mode [id]   list / set mode                           /config [id value]  list / set config
  /model <v>   set the model config option               /commands  agent slash commands
  /native      list agent-native sessions                /import <id>  import a native session
  /fork        fork conversation                         /sessions  list portable conversations
  /handoff     show what the agent hasn't seen yet       /export <file.md>  export transcript
  /providers   list LLM providers (providers/list)       /provider set <id> <apiType> <baseUrl> [Header=v ...]
  /provider disable <id>                                 /logout  log the agent out
  /delete <native-id>  delete an agent-native session    /quit`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string", short: "a" },
    resume: { type: "string", short: "r" },
    mcp: { type: "string", multiple: true },
    cwd: { type: "string" },
    yolo: { type: "boolean" },
    "shared-mcp": { type: "boolean" },
    thoughts: { type: "boolean" },
    mode: { type: "string" },
    set: { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd = "chat", ...rest] = positionals;
const cwd = resolve(opts.cwd ?? process.cwd());

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

async function openSession(host: TerminalHost): Promise<PortableSession> {
  const s = opts.resume ? PortableSession.open(opts.resume, host) : PortableSession.create(cwd, loadMcpConfig(cwd, opts.mcp), host);
  if (opts.resume && opts.mcp) Object.assign(s.conv.mcpServers, loadMcpConfig(s.conv.cwd, opts.mcp));
  s.onUpdate = (u) => host.render(u);
  if (opts["shared-mcp"]) await s.shareMcp();
  const agent = opts.agent ?? lastAgent(s) ?? "claude";
  await attach(s, agent);
  if (opts.mode) await s.setMode(opts.mode);
  for (const kv of opts.set ?? []) {
    const [id, ...v] = kv.split("=");
    const value = v.join("=");
    await s.setConfig(id, value === "true" ? true : value === "false" ? false : value);
  }
  return s;
}

function lastAgent(s: PortableSession): string | undefined {
  return s.conv.entries.findLast((e) => e.t === "user")?.agent;
}

async function attach(s: PortableSession, spec: string) {
  const kind = await s.attach(spec);
  const b = s.backend!;
  const pending = s.pendingHandoff() ? " — will hand off unseen turns on next prompt" : "";
  process.stderr.write(`\x1b[2m[${b.displayName} ${b.init.agentInfo?.version ?? ""} via ${b.agent.launcher}; ${kind} session ${s.sessionId}${pending}]\x1b[0m\n`);
}

async function listAgents() {
  const reg = await loadRegistry();
  console.log("aliases:", Object.entries(ALIASES).map(([k, v]) => `${k}→${v}`).join(", "));
  for (const a of reg.agents) console.log(`${a.id.padEnd(22)} ${a.name} ${a.version}`);
}

async function main() {
  switch (cmd) {
    case "agents": return listAgents();
    case "list": {
      for (const c of listConversations()) {
        const agents = Object.keys(c.agents).join(",");
        console.log(`${c.id}  ${c.updatedAt.slice(0, 16)}  [${agents}]  ${c.title ?? ""}`);
      }
      return;
    }
    case "show": {
      const c = loadConversation(rest[0]);
      console.log(renderHandoff(c, 0));
      return;
    }
    case "serve": {
      const { serve } = await import("./serve.ts");
      await serve({ defaultAgent: opts.agent ?? "claude", mcpFiles: opts.mcp ?? [], sharedMcp: opts["shared-mcp"] });
      return;
    }
    case "import": {
      const host = new TerminalHost();
      const s = PortableSession.create(cwd, loadMcpConfig(cwd, opts.mcp), host);
      await s.attach(opts.agent ?? "claude");
      await s.importNative(rest[0]);
      console.log(`imported ${s.conv.entries.length} entries into ${s.conv.id}`);
      s.detach();
      return;
    }
    case "run": {
      const host = new TerminalHost({ yolo: opts.yolo, showThoughts: opts.thoughts });
      const s = await openSession(host);
      const res = await s.prompt(rest.join(" "));
      host.endTurn();
      process.stderr.write(`\x1b[2m[${res.stopReason}] conversation ${s.conv.id}\x1b[0m\n`);
      s.dispose();
      return;
    }
    case "chat":
      return chat();
    default:
      console.log(HELP);
  }
}

async function chat() {
  const host = new TerminalHost({ yolo: opts.yolo, showThoughts: opts.thoughts });
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  // An async iterator buffers lines, so piped input works as well as a TTY.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string) => {
    process.stdout.write(q);
    const r = await lines.next();
    if (r.done) throw new Error("EOF");
    return r.value;
  };
  host.ask = ask;
  host.pauseInput = () => rl.pause();
  host.resumeInput = () => rl.resume();
  const s = await openSession(host);
  console.error(`\x1b[2mconversation ${s.conv.id} — /help for commands\x1b[0m`);
  let busy = false;
  rl.on("SIGINT", () => (busy ? s.cancel() : (s.detach(), process.exit(0))));
  for (;;) {
    let line: string;
    try {
      line = (await ask(`${s.agentId}> `)).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;
    try {
      if (line.startsWith("/") && (await command(s, line))) continue;
      busy = true;
      const res = await s.prompt(line);
      host.endTurn();
      if (res.stopReason !== "end_turn") console.error(`\x1b[2m[${res.stopReason}]\x1b[0m`);
    } catch (e) {
      host.endTurn();
      console.error(`\x1b[31merror:\x1b[0m ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }
  s.dispose();
  rl.close();
}

/** Returns true when the line was handled locally; agent slash commands fall through to the agent. */
async function command(s: PortableSession, line: string): Promise<boolean> {
  const [name, ...args] = line.slice(1).split(/\s+/);
  const arg = args.join(" ");
  const st = s.state;
  switch (name) {
    case "help": console.log(HELP); return true;
    case "quit": case "exit": s.detach(); process.exit(0);
    case "agent": await attach(s, arg); return true;
    case "agents": await listAgents(); return true;
    case "status": {
      console.log({ conversation: s.conv.id, agent: s.agentId, launcher: s.backend?.agent.launcher, session: s.sessionId, synced: s.conv.agents, mode: st.modes?.currentModeId, preferences: s.conv.preferences });
      return true;
    }
    case "mcp": console.log(s.conv.mcpServers, "\nagent mcp capabilities:", s.backend?.caps.mcpCapabilities); return true;
    case "mode":
      if (arg) await s.setMode(arg);
      else console.log(st.modes?.availableModes.map((m) => `${m.id === st.modes?.currentModeId ? "*" : " "} ${m.id} — ${m.name}`).join("\n") ?? "agent has no modes");
      return true;
    case "config":
      if (args.length >= 2) await s.setConfig(args[0], args[1] === "true" ? true : args[1] === "false" ? false : args.slice(1).join(" "));
      else for (const o of st.configOptions ?? []) console.log(`${o.id} (${o.category ?? "-"}) = ${o.currentValue}${o.type === "select" ? `  [${o.options.flatMap((x) => ("options" in x ? x.options : [x])).map((x) => x.value).join(", ")}]` : ""}`);
      return true;
    case "model": {
      const opt = st.configOptions?.find((o) => o.category === "model" || o.id === "model");
      if (!opt) console.log("agent exposes no model option");
      else await s.setConfig(opt.id, arg);
      return true;
    }
    case "commands": console.log(st.commands.map((c) => `/${c.name} — ${c.description}`).join("\n") || "(none)"); return true;
    case "native": for (const n of await s.listNative()) console.log(`${n.sessionId}  ${n.updatedAt ?? ""}  ${n.title ?? ""}`); return true;
    case "import": await s.importNative(arg); console.log(`imported; ${s.conv.entries.length} entries`); return true;
    case "fork": {
      const f = await s.fork();
      console.log(`forked → ${f.conv.id} (resume with --resume ${f.conv.id})`);
      return true;
    }
    case "providers": for (const p of await s.listProviders()) console.log(`${p.providerId}${p.required ? " (required)" : ""}: ${p.current ? `${p.current.apiType} ${p.current.baseUrl}` : "disabled"}  supports ${p.supported.join(",")}`); return true;
    case "provider": {
      const [sub, id, apiType, baseUrl, ...hdrs] = args;
      if (sub === "disable") await s.disableProvider(id);
      else if (sub === "set") await s.setProvider({ providerId: id, apiType, baseUrl, headers: Object.fromEntries(hdrs.map((h) => h.split("=", 2))) });
      else console.log("usage: /provider set <id> <apiType> <baseUrl> [Header=value ...] | /provider disable <id>");
      return true;
    }
    case "logout": await s.logout(); console.log("logged out"); return true;
    case "delete": await s.deleteNative(arg); console.log("deleted"); return true;
    case "sessions": for (const c of listConversations(s.conv.cwd)) console.log(`${c.id}  [${Object.keys(c.agents).join(",")}]  ${c.title ?? ""}`); return true;
    case "handoff": console.log(s.pendingHandoff() || "(agent is fully synced)"); return true;
    case "export": writeFileSync(arg || `${s.conv.id}.md`, renderHandoff(s.conv, 0)); console.log("written"); return true;
    default:
      return false; // e.g. /compact, /review: let the agent handle its own commands
  }
}

main().catch((e) => {
  console.error(`\x1b[31merror:\x1b[0m ${e.message}`);
  process.exit(1);
});
