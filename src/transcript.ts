// The portable conversation: an agent-neutral transcript built from ACP
// session/update notifications, plus the native session id each agent holds
// and how far that agent has been synced. This file is the unit of portability.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { PortableMcpServers } from "./mcp.ts";

export type Entry =
  | { t: "user"; turn: number; agent: string; content: acp.ContentBlock[] }
  | { t: "assistant" | "thought"; turn: number; agent: string; text: string }
  | { t: "tool"; turn: number; agent: string; id: string; title: string; kind?: string; status?: string; input?: unknown; output?: string; locations?: string[] }
  | { t: "plan"; turn: number; agent: string; entries: { content: string; status: string }[] }
  | { t: "stop"; turn: number; agent: string; stopReason: string };

export type Conversation = {
  version: 1;
  id: string;
  title?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  mcpServers: PortableMcpServers;
  /** agent id -> native session and the last turn that session has seen */
  agents: Record<string, { sessionId: string; syncedTurn: number }>;
  /** last-known mode / config choices, re-applied when an agent offers the same ids */
  preferences: { mode?: string; config: Record<string, string | boolean> };
  entries: Entry[];
};

export const STORE = process.env.ACP_PORTABLE_HOME ?? join(homedir(), ".acp-portable", "conversations");

export function newConversation(cwd: string, mcpServers: PortableMcpServers = {}): Conversation {
  const now = new Date().toISOString();
  return { version: 1, id: randomUUID(), cwd, createdAt: now, updatedAt: now, mcpServers, agents: {}, preferences: { config: {} }, entries: [] };
}

export function saveConversation(c: Conversation) {
  mkdirSync(STORE, { recursive: true });
  c.updatedAt = new Date().toISOString();
  const file = join(STORE, `${c.id}.json`);
  writeFileSync(file + ".tmp", JSON.stringify(c, null, 2));
  renameSync(file + ".tmp", file);
}

export function loadConversation(idOrPath: string): Conversation {
  const file = existsSync(idOrPath) ? idOrPath : join(STORE, `${idOrPath}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const match = listConversations().find((c) => c.id.startsWith(idOrPath));
  if (!match) throw new Error(`no conversation ${idOrPath}`);
  return JSON.parse(readFileSync(join(STORE, `${match.id}.json`), "utf8"));
}

export function deleteConversation(id: string) {
  rmSync(join(STORE, `${id}.json`), { force: true });
}

export function listConversations(cwd?: string): Conversation[] {
  if (!existsSync(STORE)) return [];
  return readdirSync(STORE)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(STORE, f), "utf8")) as Conversation)
    .filter((c) => !cwd || c.cwd === cwd)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function currentTurn(c: Conversation): number {
  return c.entries.reduce((n, e) => Math.max(n, e.turn), 0);
}

/** Fold one ACP session update into the transcript. Chunks coalesce; tool calls merge by id. */
export function record(c: Conversation, turn: number, agent: string, u: acp.SessionUpdate) {
  const last = c.entries[c.entries.length - 1];
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const t = u.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought";
      const text = blockText(u.content);
      if (last && last.t === t && last.turn === turn && last.agent === agent) last.text += text;
      else c.entries.push({ t, turn, agent, text });
      break;
    }
    case "tool_call":
    case "tool_call_update": {
      let e = c.entries.find((x): x is Extract<Entry, { t: "tool" }> => x.t === "tool" && x.id === u.toolCallId && x.turn === turn);
      if (!e) c.entries.push((e = { t: "tool", turn, agent, id: u.toolCallId, title: u.title ?? "tool" }));
      if (u.title) e.title = u.title;
      if (u.kind) e.kind = u.kind;
      if (u.status) e.status = u.status;
      if (u.rawInput !== undefined) e.input = u.rawInput;
      if (u.locations) e.locations = u.locations.map((l) => l.path);
      const out = (u.content ?? []).map(toolContentText).filter(Boolean).join("\n");
      if (out) e.output = out;
      else if (u.rawOutput !== undefined && !e.output) e.output = typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput);
      break;
    }
    case "plan":
      c.entries.push({ t: "plan", turn, agent, entries: u.entries.map((p) => ({ content: p.content, status: p.status })) });
      break;
    case "session_info_update":
      if (u.title) c.title = u.title;
      break;
  }
}

export function blockText(b: acp.ContentBlock): string {
  switch (b.type) {
    case "text": return b.text;
    case "resource_link": return `[${b.name}](${b.uri})`;
    case "resource": return "text" in b.resource ? `<resource uri="${b.resource.uri}">\n${b.resource.text}\n</resource>` : `[binary resource ${b.resource.uri}]`;
    case "image": return "[image]";
    case "audio": return "[audio]";
    default: return "";
  }
}

function toolContentText(c: acp.ToolCallContent): string {
  if (c.type === "content") return blockText(c.content);
  if (c.type === "diff") return `--- ${c.path}\n${c.oldText ? "(modified)" : "(new file)"}\n${clip(c.newText, 1500)}`;
  if (c.type === "terminal") return `[terminal ${c.terminalId}]`;
  return "";
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s;
}

/**
 * Render turns after `afterTurn` as a handoff document another agent can read.
 * Reasoning the agent exposed via `agent_thought_chunk` is included (clipped,
 * ACP_PORTABLE_HANDOFF_THOUGHTS=0 to drop it); tool calls are kept with clipped
 * input/output so the next agent knows what was already done.
 */
export function renderHandoff(c: Conversation, afterTurn: number, agentNames: Record<string, string> = {}, thoughts = process.env.ACP_PORTABLE_HANDOFF_THOUGHTS !== "0"): string {
  const lines: string[] = [];
  for (const e of c.entries) {
    if (e.turn <= afterTurn) continue;
    const who = agentNames[e.agent] ?? e.agent;
    switch (e.t) {
      case "user": lines.push(`### User (turn ${e.turn})\n${e.content.map(blockText).join("\n")}`); break;
      case "assistant": lines.push(`### Assistant — ${who}\n${e.text.trim()}`); break;
      case "thought": if (thoughts && e.text.trim()) lines.push(`### Reasoning — ${who}\n${clip(e.text.trim(), 2000)}`); break;
      case "tool": {
        const input = e.input === undefined ? "" : `\ninput: ${clip(JSON.stringify(e.input), 600)}`;
        const output = e.output ? `\noutput:\n${clip(e.output, 1200)}` : "";
        lines.push(`### Tool call — ${who}: ${e.title} [${e.kind ?? "other"}, ${e.status ?? "unknown"}]${input}${output}`);
        break;
      }
      case "plan": lines.push(`### Plan — ${who}\n${e.entries.map((p) => `- [${p.status}] ${p.content}`).join("\n")}`); break;
      case "stop": if (e.stopReason !== "end_turn") lines.push(`(turn ${e.turn} ended: ${e.stopReason})`); break;
    }
  }
  return lines.join("\n\n");
}
