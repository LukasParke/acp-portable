// Host for the interactive/one-shot CLI: renders session updates to stdout,
// asks the user about permissions and elicitations, and runs fs/terminal locally.
import { spawn } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { AgentCommand } from "./agents.ts";
import type { Host } from "./backend.ts";
import { LocalCapabilities } from "./local-host.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

export class TerminalHost extends LocalCapabilities implements Host {
  capabilities: acp.ClientCapabilities = {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    elicitation: { form: {} },
    session: { notices: {} },
    auth: { terminal: !!process.stdin.isTTY },
  };
  /** Suspend/resume line input while a child process owns the terminal. */
  pauseInput = () => {};
  resumeInput = () => {};
  /** Line prompt for permissions/elicitation; unset = non-interactive. */
  ask?: (q: string) => Promise<string>;
  yolo: boolean;
  showThoughts: boolean;
  out: (s: string) => void;
  private atLineStart = true;
  private toolTitles = new Map<string, string>();

  constructor(opts: { yolo?: boolean; showThoughts?: boolean; out?: (s: string) => void } = {}) {
    super();
    this.yolo = opts.yolo ?? false;
    this.showThoughts = opts.showThoughts ?? false;
    this.out = opts.out ?? ((s) => process.stdout.write(s));
  }

  private write(s: string) {
    if (!s) return;
    this.out(s);
    this.atLineStart = s.endsWith("\n");
  }

  private line(s: string) {
    this.write(`${this.atLineStart ? "" : "\n"}${s}\n`);
  }

  update(_n: acp.SessionNotification) {} // rendering happens via render(), which only sees active-session updates

  render(u: acp.SessionUpdate) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.write(u.content.text);
        break;
      case "agent_thought_chunk":
        if (this.showThoughts && u.content.type === "text") this.write(dim(u.content.text));
        break;
      case "tool_call":
        this.toolTitles.set(u.toolCallId, u.title);
        this.line(cyan(`⚙ ${u.title}${u.kind ? dim(` [${u.kind}]`) : ""}`));
        break;
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed") this.line(dim(`${u.status === "completed" ? "✓" : "✗"} ${u.title ?? this.toolTitles.get(u.toolCallId) ?? u.toolCallId}`));
        break;
      case "plan":
        this.line(dim("plan:\n" + u.entries.map((e) => `  [${e.status === "completed" ? "x" : e.status === "in_progress" ? "~" : " "}] ${e.content}`).join("\n")));
        break;
      case "current_mode_update":
        this.line(dim(`mode → ${u.currentModeId}`));
        break;
      case "notice":
        this.line(dim(`notice: ${JSON.stringify((u as { message?: unknown }).message ?? u)}`));
        break;
    }
  }

  endTurn() {
    if (!this.atLineStart) this.write("\n");
  }

  async requestPermission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const pick = (kinds: string[]) => r.options.find((o) => kinds.includes(o.kind));
    if (this.yolo) {
      const o = pick(["allow_always"]) ?? pick(["allow_once"]) ?? r.options[0];
      this.line(dim(`auto-approved: ${r.toolCall.title ?? "tool"} (${o.name})`));
      return { outcome: { outcome: "selected", optionId: o.optionId } };
    }
    if (!this.ask) {
      const o = pick(["reject_once", "reject_always"]);
      return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    this.line(`\x1b[33mpermission:\x1b[0m ${r.toolCall.title ?? "tool call"}`);
    r.options.forEach((o, i) => this.line(`  ${i + 1}) ${o.name} ${dim(o.kind)}`));
    const answer = await this.ask("choose> ");
    const o = r.options[Number(answer) - 1];
    return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  async runTerminalAuth(cmd: AgentCommand, methodName: string) {
    if (!process.stdin.isTTY) throw new Error(`${cmd.id} needs interactive login (${methodName}); run in a terminal`);
    this.line(`\x1b[33mlogin:\x1b[0m ${methodName} — running ${cmd.command} ${cmd.args.join(" ")}`);
    this.pauseInput();
    try {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(cmd.command, cmd.args, { stdio: "inherit", env: { ...process.env, ...cmd.env } });
        p.on("exit", () => resolve());
        p.on("error", reject);
      });
    } finally {
      this.resumeInput();
    }
  }

  async collectEnv(agentId: string, method: { name: string; vars: { name: string; label?: string; optional?: boolean }[] }) {
    if (!this.ask) return {};
    this.line(`\x1b[33m${agentId} needs credentials:\x1b[0m ${method.name} (leave blank to skip; save them in ~/.config/acp-portable/agents.json to avoid this)`);
    const env: Record<string, string> = {};
    for (const v of method.vars) {
      const value = (await this.ask(`${v.label ?? v.name} (${v.name}${v.optional ? ", optional" : ""}): `)).trim();
      if (value) env[v.name] = value;
    }
    return env;
  }

  async elicit(r: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    if (!this.ask || r.mode !== "form") return { action: "decline" };
    this.line(`\x1b[33minput requested:\x1b[0m ${r.message}`);
    const schema = (r as { requestedSchema: { properties?: Record<string, { type?: string; title?: string; description?: string }> } }).requestedSchema;
    const content: Record<string, string | number | boolean> = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      const v = await this.ask(`${prop.title ?? key}${prop.description ? dim(` (${prop.description})`) : ""}: `);
      content[key] = prop.type === "number" || prop.type === "integer" ? Number(v) : prop.type === "boolean" ? /^y|true/i.test(v) : v;
    }
    return { action: "accept", content } as acp.CreateElicitationResponse;
  }
}
