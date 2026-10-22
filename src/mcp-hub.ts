// MCP servers that live in acp-portable rather than in any one agent:
//  * "acp" servers handed to us by an upstream ACP client (MCP-over-ACP,
//    `mcp/message`), proxied to the active backend; and
//  * shared local servers (--shared-mcp): one connection per server that every
//    agent reuses, so server-side state survives switching agents.
// Agents that advertise `mcpCapabilities.acp` get `{type:"acp"}` entries and
// talk `mcp/message`; all others get a stdio bridge into a unix socket here.
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { PortableMcpServer } from "./mcp.ts";

const BRIDGE = fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url));

type JsonRpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type Call = (req: acp.MessageMcpRequest) => Promise<acp.MessageMcpResponse>;
type Hosted = { name: string; serverId: string; call: Call; socket: string; listener: Server; conns: Map<string, Socket> };

export class McpHub {
  private servers = new Map<string, Hosted>();
  private http = new Map<string, Promise<{ url: string; server: HttpServer; transport: Transport }>>();
  /** Delivers provider notifications to an ACP-transport consumer (the active backend). */
  toAcpConsumer?: (n: acp.MessageMcpNotification) => void;

  get size() {
    return this.servers.size;
  }

  /** An MCP server provided over ACP by the upstream client. */
  async addUpstream(server: acp.McpServerAcp, upstream: Call) {
    await this.host(server.name, server.serverId, upstream);
  }

  /** A server this process connects to once and shares with every agent. */
  async addLocal(name: string, s: PortableMcpServer) {
    const transport: Transport = "command" in s
      ? new StdioClientTransport({ command: s.command, args: s.args ?? [], env: { ...(process.env as Record<string, string>), ...s.env }, stderr: "ignore" })
      : s.type === "sse"
        ? new SSEClientTransport(new URL(s.url), { requestInit: { headers: s.headers } })
        : new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers } });
    const pending = new Map<number, (m: JsonRpc) => void>();
    let next = 1;
    const serverId = `local-${name}-${randomUUID().slice(0, 8)}`;
    transport.onmessage = (m: JsonRpc) => {
      if (m.id !== undefined && pending.has(m.id as number)) {
        pending.get(m.id as number)!(m);
        pending.delete(m.id as number);
      } else if (m.method && m.id === undefined) {
        this.deliver({ serverId, requestId: "*", method: m.method, params: m.params ?? null });
      }
    };
    await transport.start();
    const rpc = (method: string, params?: unknown) =>
      new Promise<JsonRpc>((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        void transport.send({ jsonrpc: "2.0", id, method, params } as never);
      });
    // Handshake once; every consumer's own `initialize` is answered from this.
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acp-portable", version: "0.1.0" } });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
    await this.host(name, serverId, async (req) => {
      if (req.method === "initialize") return { result: init.result };
      const r = await rpc(req.method, req.params ?? undefined);
      return r.error ? { error: r.error as acp.McpError } : { result: r.result ?? null };
    });
  }

  private async host(name: string, serverId: string, call: Call) {
    const socket = join(tmpdir(), `acpp-${process.pid}-${serverId.replace(/[^\w-]/g, "_")}.sock`);
    rmSync(socket, { force: true });
    const conns = new Map<string, Socket>();
    const listener = createServer((sock) => {
      const connId = randomUUID().slice(0, 8);
      conns.set(connId, sock);
      sock.on("close", () => conns.delete(connId));
      let buf = "";
      sock.on("data", (d) => {
        buf += d;
        for (let i; (i = buf.indexOf("\n")) >= 0; ) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) void this.fromBridge(serverId, connId, sock, JSON.parse(line));
        }
      });
    });
    await new Promise<void>((r) => listener.listen(socket, r));
    this.servers.set(serverId, { name, serverId, call, socket, listener, conns });
  }

  /** A JSON-RPC message from an agent's stdio bridge. Inner requests become `mcp/message` calls. */
  private async fromBridge(serverId: string, connId: string, sock: Socket, m: JsonRpc) {
    if (m.id === undefined || !m.method) return; // consumer notifications/responses have no ACP carrier
    const write = (o: object) => sock.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }) + "\n");
    try {
      const r = await this.call({ serverId, requestId: `${connId}:${m.id}`, method: m.method, params: m.params ?? null });
      write("error" in r && r.error ? { error: r.error } : { result: (r as { result: unknown }).result ?? {} });
    } catch (e) {
      write({ error: { code: -32603, message: (e as Error).message } });
    }
  }

  /** Inner MCP request from a consumer (bridge or ACP-transport backend). */
  call(req: acp.MessageMcpRequest): Promise<acp.MessageMcpResponse> {
    const s = this.servers.get(req.serverId);
    if (!s) return Promise.resolve({ error: { code: -32601, message: `unknown MCP server ${req.serverId}` } });
    return s.call(req);
  }

  /** Provider -> consumer notification (progress, list_changed, ...). */
  deliver(n: acp.MessageMcpNotification) {
    const s = this.servers.get(n.serverId);
    if (!s) return;
    const connId = String(n.requestId).split(":")[0];
    const targets = s.conns.has(connId) ? [s.conns.get(connId)!] : [...s.conns.values()];
    for (const t of targets) t.write(JSON.stringify({ jsonrpc: "2.0", method: n.method, params: n.params ?? undefined }) + "\n");
    this.toAcpConsumer?.(n);
  }

  /** How a given agent should reach every hosted server. */
  entries(caps: acp.McpCapabilities | undefined): acp.McpServer[] {
    return [...this.servers.values()].map((s): acp.McpServer =>
      caps?.acp
        ? { type: "acp", name: s.name, serverId: s.serverId }
        : { name: s.name, command: process.execPath, args: [BRIDGE, "unix", s.socket], env: [] },
    );
  }

  /**
   * Serve a stdio MCP server as a local streamable-HTTP endpoint (JSON response
   * mode), for agents that reject stdio MCP despite the spec (dimcode). Started
   * lazily and shared by every agent that needs it.
   */
  httpUrl(name: string, s: { command: string; args?: string[]; env?: Record<string, string> }): Promise<string> {
    if (!this.http.has(name)) {
      this.http.set(name, (async () => {
        const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [], env: { ...(process.env as Record<string, string>), ...s.env }, stderr: "ignore" });
        const pending = new Map<string | number, (m: JsonRpc) => void>();
        transport.onmessage = (m: JsonRpc) => {
          if (m.id !== undefined && pending.has(m.id)) {
            pending.get(m.id)!(m);
            pending.delete(m.id);
          }
        };
        await transport.start();
        const server = createHttpServer((req, res) => {
          if (req.method !== "POST") return void res.writeHead(405).end();
          let body = "";
          req.on("data", (d) => (body += d));
          req.on("end", async () => {
            const msgs: JsonRpc[] = [JSON.parse(body)].flat();
            const replies = await Promise.all(msgs.map((m) => {
              void transport.send(m as never);
              return m.id !== undefined && m.method ? new Promise<JsonRpc>((r) => pending.set(m.id!, r)) : undefined;
            }));
            const out = replies.filter(Boolean);
            if (!out.length) return void res.writeHead(202).end();
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
          });
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, server, transport };
      })());
    }
    return this.http.get(name)!.then((h) => h.url);
  }

  has(name: string) {
    return [...this.servers.values()].some((s) => s.name === name);
  }

  close() {
    for (const h of this.http.values()) void h.then(({ server, transport }) => (server.close(), transport.close()));
    this.http.clear();
    for (const s of this.servers.values()) {
      s.listener.close();
      rmSync(s.socket, { force: true });
    }
    this.servers.clear();
  }
}
