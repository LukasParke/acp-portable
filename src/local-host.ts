// Client-side ACP capabilities implemented against the local machine:
// file reads/writes and terminals. Used directly by the CLI and as the
// fallback when an upstream client (serve mode) lacks a capability.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type * as acp from "@agentclientprotocol/sdk/unstable";

type Term = { proc: ChildProcess; output: string; limit: number; truncated: boolean; exit: Promise<acp.TerminalExitStatus>; status?: acp.TerminalExitStatus };

export class LocalCapabilities {
  private terms = new Map<string, Term>();

  async readTextFile({ path, line, limit }: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const text = readFileSync(path, "utf8");
    if (line == null && limit == null) return { content: text };
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    return { content: lines.slice(start, limit == null ? undefined : start + limit).join("\n") };
  }

  async writeTextFile({ path, content }: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return {};
  }

  async createTerminal(r: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const env = Object.fromEntries((r.env ?? []).map((e) => [e.name, e.value]));
    // Agents send either a full shell line in `command` or an argv split across command/args.
    const proc = r.args?.length
      ? spawn(r.command, r.args, { cwd: r.cwd ?? undefined, env: { ...process.env, ...env } })
      : spawn(r.command, { cwd: r.cwd ?? undefined, env: { ...process.env, ...env }, shell: true });
    const term: Term = { proc, output: "", limit: r.outputByteLimit ?? 1_000_000, truncated: false, exit: undefined! };
    const onData = (d: Buffer) => {
      term.output += d.toString();
      if (Buffer.byteLength(term.output) > term.limit) {
        term.output = term.output.slice(-term.limit);
        term.truncated = true;
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    term.exit = new Promise((resolve) => {
      proc.on("close", (exitCode, signal) => resolve((term.status = { exitCode, signal })));
      proc.on("error", (e) => {
        term.output += String(e);
        resolve((term.status = { exitCode: 127, signal: null }));
      });
    });
    const id = randomUUID();
    this.terms.set(id, term);
    return { terminalId: id };
  }

  private term(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new Error(`unknown terminal ${id}`);
    return t;
  }

  async terminalOutput({ terminalId }: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse> {
    const t = this.term(terminalId);
    return { output: t.output, truncated: t.truncated, exitStatus: t.status ?? null };
  }

  async waitForTerminalExit({ terminalId }: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    return await this.term(terminalId).exit;
  }

  async killTerminal({ terminalId }: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse> {
    this.term(terminalId).proc.kill();
    return {};
  }

  async releaseTerminal({ terminalId }: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse> {
    this.terms.get(terminalId)?.proc.kill();
    this.terms.delete(terminalId);
    return {};
  }
}
