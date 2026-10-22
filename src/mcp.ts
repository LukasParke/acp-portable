// Portable MCP config. One `mcpServers` map (the format Claude Code, Cursor,
// Pi, etc. already use) is translated per agent into ACP `McpServer` entries.
// When an agent lacks a transport (e.g. Pi has no http, Codex has no sse) the
// server is wrapped in a stdio bridge so every agent sees every server.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk/unstable";

export type PortableMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { type?: "http" | "sse" | "streamable-http"; url: string; headers?: Record<string, string> };
export type PortableMcpServers = Record<string, PortableMcpServer>;

const BRIDGE = fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url));

/** Merge MCP config from ~/.config/acp-portable/mcp.json, ./.mcp.json and explicit files (later wins). */
export function loadMcpConfig(cwd: string, extra: string[] = []): PortableMcpServers {
  const files = [join(homedir(), ".config", "acp-portable", "mcp.json"), join(cwd, ".mcp.json"), ...extra.map((f) => resolve(cwd, f))];
  const out: PortableMcpServers = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    const json = JSON.parse(readFileSync(f, "utf8"));
    Object.assign(out, json.mcpServers ?? json);
  }
  return out;
}

function which(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  return cmd;
}

const kv = (o: Record<string, string> = {}) => Object.entries(o).map(([name, value]) => ({ name, value }));

/** Translate portable servers into what this particular agent can consume. */
export function toAcp(servers: PortableMcpServers, caps: acp.McpCapabilities | undefined): acp.McpServer[] {
  return Object.entries(servers).map(([name, s]): acp.McpServer => {
    if ("command" in s) return { name, command: which(s.command), args: s.args ?? [], env: kv(s.env) };
    const transport = s.type === "sse" ? "sse" : "http";
    if (transport === "http" && caps?.http) return { type: "http", name, url: s.url, headers: kv(s.headers) };
    if (transport === "sse" && caps?.sse) return { type: "sse", name, url: s.url, headers: kv(s.headers) };
    // Agent can't speak this transport: hand it a stdio server that forwards to the remote one.
    return {
      name,
      command: process.execPath,
      args: [BRIDGE, transport, s.url],
      env: kv({ ACP_PORTABLE_MCP_HEADERS: JSON.stringify(s.headers ?? {}) }),
    };
  });
}

/** Inverse of toAcp, used when an upstream ACP client hands us its MCP servers. */
export function fromAcp(servers: acp.McpServer[] = []): PortableMcpServers {
  const out: PortableMcpServers = {};
  const obj = (l: { name: string; value: string }[] = []) => Object.fromEntries(l.map((h) => [h.name, h.value]));
  for (const s of servers) {
    if ("command" in s) out[s.name] = { command: s.command, args: s.args, env: obj(s.env) };
    else if ("url" in s) out[s.name] = { type: s.type as "http" | "sse", url: s.url, headers: obj(s.headers) };
  }
  return out;
}
