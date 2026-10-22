// One live connection to one ACP agent process. Every client-side request the
// agent makes (permissions, fs, terminals, elicitation) is delegated to a Host,
// so the same backend can serve a terminal UI or be proxied to another client.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, read, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { AgentCommand } from "./agents.ts";

const live = new Set<ChildProcess>();
function killGroup(child: ChildProcess) {
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    child.kill();
  }
}
process.once("exit", () => live.forEach(killGroup));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(130));

/** Tail a file the child writes its stdout into, ending once the child has exited and the file is drained. */
function followFile(path: string, child: ChildProcess): ReadableStream<Uint8Array> {
  const fd = openSync(path, "r");
  let pos = 0;
  let exited = false;
  child.once("exit", () => (exited = true));
  const buf = Buffer.alloc(1 << 20);
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const n = await new Promise<number>((res, rej) => read(fd, buf, 0, buf.length, pos, (e, b) => (e ? rej(e) : res(b))));
        if (n > 0) {
          pos += n;
          controller.enqueue(new Uint8Array(buf.subarray(0, n)));
          return;
        }
        if (exited) {
          closeSync(fd);
          rmSync(path, { force: true });
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  });
}

export interface Host {
  capabilities: acp.ClientCapabilities;
  update(n: acp.SessionNotification): void;
  requestPermission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  readTextFile(r: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(r: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  createTerminal(r: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  terminalOutput(r: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
  waitForTerminalExit(r: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse>;
  killTerminal(r: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse>;
  releaseTerminal(r: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse>;
  elicit(r: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
  /** MCP-over-ACP: an inner MCP request from the agent to a client-provided server. */
  mcpMessage?(r: acp.MessageMcpRequest): Promise<acp.MessageMcpResponse>;
  /** Ask the user for the variables of a draft-ACP `env_var` auth method. */
  collectEnv?(agentId: string, method: { name: string; vars: { name: string; label?: string; optional?: boolean }[] }): Promise<Record<string, string>>;
  /** Run a terminal auth method interactively (agent command + method args/env). */
  runTerminalAuth?(cmd: AgentCommand, methodName: string): Promise<void>;
}

export class Backend {
  readonly agent: AgentCommand;
  readonly child: ChildProcess;
  readonly conn: acp.ClientConnection;
  init!: acp.InitializeResponse;
  stderr = "";

  private constructor(agent: AgentCommand, child: ChildProcess, conn: acp.ClientConnection) {
    this.agent = agent;
    this.child = child;
    this.conn = conn;
  }

  get rpc(): acp.ClientContext {
    return this.conn.agent;
  }

  get caps(): acp.AgentCapabilities {
    return this.init.agentCapabilities ?? {};
  }

  get displayName(): string {
    return this.init.agentInfo?.title ?? this.init.agentInfo?.name ?? this.agent.name;
  }

  static async start(agent: AgentCommand, host: Host, cwd: string): Promise<Backend> {
    // Own process group, so wrappers (npx, ori, uvx) and their children die together.
    const out = agent.stdoutViaFile ? join(mkdtempSync(join(tmpdir(), "acpp-out-")), "stdout") : undefined;
    const outFd = out ? openSync(out, "w") : undefined;
    const child = spawn(agent.command, agent.args, { cwd, env: { ...process.env, ...agent.env }, stdio: ["pipe", outFd ?? "pipe", "pipe"], detached: true });
    if (outFd !== undefined) closeSync(outFd);
    live.add(child);
    child.once("exit", () => live.delete(child));
    const app = acp
      .client({ name: "acp-portable" })
      .onNotification("session/update", ({ params }) => host.update(params))
      .onRequest("session/request_permission", ({ params }) => host.requestPermission(params))
      .onRequest("fs/read_text_file", ({ params }) => host.readTextFile(params))
      .onRequest("fs/write_text_file", ({ params }) => host.writeTextFile(params))
      .onRequest("terminal/create", ({ params }) => host.createTerminal(params))
      .onRequest("terminal/output", ({ params }) => host.terminalOutput(params))
      .onRequest("terminal/wait_for_exit", ({ params }) => host.waitForTerminalExit(params))
      .onRequest("terminal/kill", ({ params }) => host.killTerminal(params))
      .onRequest("terminal/release", ({ params }) => host.releaseTerminal(params))
      .onRequest("elicitation/create", ({ params }) => host.elicit(params))
      // Unstable and not in the SDK's method table, hence the explicit parser.
      .onRequest("mcp/message", (p) => p as acp.MessageMcpRequest, ({ params }): Promise<acp.MessageMcpResponse> =>
        host.mcpMessage?.(params) ?? Promise.resolve({ error: { code: -32601, message: "no MCP-over-ACP servers" } }));
    const input = out ? followFile(out, child) : (Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, input);
    const backend = new Backend(agent, child, app.connect(stream));
    child.stderr!.on("data", (d) => {
      backend.stderr = (backend.stderr + d).slice(-20_000);
      if (process.env.ACP_PORTABLE_DEBUG) process.stderr.write(d);
    });
    const exited = new Promise<never>((_, reject) =>
      child.once("exit", (code) => reject(new Error(`${agent.name} exited (${code}) before initializing:\n${backend.stderr.slice(-2000)}`))),
    );
    child.once("error", (e) => backend.conn.close(e));
    backend.init = await Promise.race([
      backend.rpc.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: host.capabilities,
        clientInfo: { name: "acp-portable", version: "0.1.0" },
      }),
      exited,
    ]);
    return backend;
  }

  close() {
    this.conn.close();
    killGroup(this.child);
  }
}
