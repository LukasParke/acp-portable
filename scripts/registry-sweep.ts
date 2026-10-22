// Exercise every agent in the ACP registry through acp-portable's own
// resolver + backend: initialize, session/new (with an MCP server), and a
// one-line prompt where a session could be opened. Writes test/registry-sweep.{json,md}.
//   node scripts/registry-sweep.ts [id ...]
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { loadRegistry, resolveAgent } from "../src/agents.ts";
import { Backend } from "../src/backend.ts";
import { toAcp } from "../src/mcp.ts";
import { TerminalHost } from "../src/terminal-host.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const registry = await loadRegistry();
const fakeLlm = process.argv.includes("--fake-llm");
const argIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// --fake-llm: agents that accept a custom model endpoint are pointed at
// test/fake-llm.ts with dummy keys (see fakeRecipes there), so the real harness
// runs end to end over ACP without real credentials.

let fake: { url: string; close: () => void } | undefined;
if (fakeLlm) {
  const { startFakeLlm, fakeRecipes, prepareRecipes } = await import("../test/fake-llm.ts");
  fake = await startFakeLlm();
  const settings = join(mkdtempSync(join(tmpdir(), "sweep-fake-")), "agents.json");
  writeFileSync(settings, JSON.stringify(prepareRecipes(fakeRecipes(fake.url), argIds.length ? argIds : undefined), null, 2));
  process.env.ACP_PORTABLE_AGENTS = settings;
}
const ids = argIds.length ? argIds : fakeLlm ? Object.keys((await import("../test/fake-llm.ts")).fakeRecipes("")) : registry.agents.map((a) => a.id);
const mcp = { codeword: { command: process.execPath, args: [join(root, "examples/codeword-mcp.ts")] } };

// A marketplace agent that can settle payments; initialize/session only, never prompt it.
const NO_PROMPT = new Set(["agoragentic-acp"]);

type Row = { id: string; fakeLlm?: boolean; launcher?: string; stage: string; ok: boolean; agent?: string; caps?: string; detail?: string; reply?: string };

const timeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms))]);

function capsSummary(c: acp.AgentCapabilities): string {
  const s = c.sessionCapabilities ?? {};
  const f = [
    c.loadSession && "load",
    ...(["resume", "list", "fork", "close", "delete"] as const).filter((k) => s[k]).map(String),
    c.mcpCapabilities?.http && "mcp:http",
    c.mcpCapabilities?.sse && "mcp:sse",
    c.mcpCapabilities?.acp && "mcp:acp",
    c.promptCapabilities?.image && "image",
    c.promptCapabilities?.embeddedContext && "embedded",
    c.providers && "providers",
  ];
  return f.filter(Boolean).join(" ");
}

async function probe(id: string): Promise<Row> {
  const row: Row = { id, stage: "resolve", ok: false, fakeLlm: fakeLlm || undefined };
  let b: Backend | undefined;
  const cwd = mkdtempSync(join(tmpdir(), `sweep-${id}-`));
  try {
    const agent = await timeout(resolveAgent(id), 240_000, "install");
    row.launcher = agent.launcher;
    row.stage = "initialize";
    let text = "";
    let sessionId = "";
    const host = new TerminalHost({ yolo: true, out: () => {} });
    host.update = (n) => {
      if (n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text") text += n.update.content.text;
    };
    b = await timeout(Backend.start(agent, host, cwd), 240_000, "initialize");
    row.agent = `${b.init.agentInfo?.name ?? "?"} ${b.init.agentInfo?.version ?? ""}`.trim();
    row.caps = capsSummary(b.caps);
    row.stage = "session/new";
    const s = await timeout(b.rpc.request("session/new", { ...agent.sessionParams, cwd, mcpServers: toAcp(mcp, b.caps.mcpCapabilities) }), 120_000, "session/new");
    sessionId = s.sessionId;
    for (const [configId, value] of Object.entries(agent.defaults ?? {})) {
      await b.rpc.request("session/set_config_option", { sessionId, configId, value });
    }
    if (NO_PROMPT.has(id)) {
      row.detail = "session created; prompt skipped (payments agent)";
      return row;
    }
    row.stage = "prompt";
    const r = await timeout(b.rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Reply with exactly the word PONG and nothing else. Do not use tools." }] }), 180_000, "prompt");
    row.reply = text.trim().slice(-60);
    row.ok = r.stopReason === "end_turn" && /PONG/.test(text);
    row.stage = row.ok ? "done" : "prompt";
    if (!row.ok) row.detail = `stop=${r.stopReason} text=${JSON.stringify(text.slice(0, 120))}`;
  } catch (e) {
    const err = e as Error & { code?: number; data?: unknown };
    row.detail = `${err.code === -32000 ? "auth_required: " : ""}${err.message}`.replace(/\s+/g, " ").slice(0, 220);
    if (b?.init?.authMethods?.length) row.detail += ` [auth methods: ${b.init.authMethods.map((m) => m.id).join(", ")}]`;
  } finally {
    b?.close();
  }
  console.log(`${row.ok ? "OK  " : "FAIL"} ${id.padEnd(22)} ${row.stage.padEnd(12)} ${row.agent ?? ""} ${row.detail ?? row.reply ?? ""}`);
  return row;
}

const rows: Row[] = [];
const queue = [...ids];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let id; (id = queue.shift()); ) rows.push(await probe(id));
}));
// Merge with earlier results so partial re-runs (`registry-sweep.ts kilo`) don't drop other rows.
const file = join(root, fakeLlm ? "test/registry-sweep-fake-llm.json" : "test/registry-sweep.json");
const prior: Row[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const merged = [...prior.filter((p) => !rows.some((r) => r.id === p.id)), ...rows].sort((a, b) => a.id.localeCompare(b.id));
rows.splice(0, rows.length, ...merged);
writeFileSync(file, JSON.stringify(rows, null, 2));
const md = [
  `| agent | launcher | reached | protocol caps | result |`,
  `|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} | ${r.launcher ?? "-"} | ${r.stage} | ${r.caps ?? "-"} | ${r.ok ? `✅ ${r.reply}` : (r.detail ?? "").replace(/\|/g, "/")} |`),
];
writeFileSync(join(root, fakeLlm ? "test/registry-sweep-fake-llm.md" : "test/registry-sweep.md"), md.join("\n") + "\n");
fake?.close();
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} completed a prompt; ${rows.filter((r) => r.stage !== "resolve" && r.stage !== "initialize").length} initialized`);
process.exit(0);
