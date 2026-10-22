// Portability across harnesses that have no credentials here: each real agent
// is pointed at test/fake-llm.ts (dummy keys, see fakeRecipes). The fake model
// always says PONG, so instead of asking the model we inspect what each harness
// sends to its model during its turn:
//   * the fact told to the first agent must be in the next agents' requests
//     (the handoff reached the harness and the harness passed it to its LLM)
//   * the fake model calls the portable MCP server's tool, so each harness must
//     really execute it (checked in the MCP server's own call log)
//   node test/fake-portability.ts [agent ...]
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeRecipes, prepareRecipes, startFakeLlm } from "./fake-llm.ts";
import { PortableSession } from "../src/portable.ts";
import { TerminalHost } from "../src/terminal-host.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const agents = process.argv.slice(2).length ? process.argv.slice(2) : ["gemini", "qwen-code", "goose", "vtcode", "mistral-vibe", "glm-acp-agent", "dirac", "fast-agent", "dimcode"];
let failures = 0;
// Agents with no MCP client in their ACP mode, so there is nothing to carry MCP into.
const NO_ACP_MCP: Record<string, string> = {
  vtcode: "vtcode's ACP agent (vtcode-acp/src/zed/agent) has a fixed tool set without MCP",
  dirac: "dirac ships no MCP client (only the ACP SDK's schema mentions mcpServers)",
};
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${what}`);
  if (!ok) failures++;
};

const fake = await startFakeLlm();
const dir = mkdtempSync(join(tmpdir(), "acpp-fakeport-"));
process.env.ACP_PORTABLE_AGENTS = join(dir, "agents.json");
// Gemini CLI and its fork qwen-code only load MCP servers in trusted folders.
// Trust is a deliberate safety feature acp-portable never bypasses; this test
// trusts its own temp workspace explicitly, as a user would for a real project.
const trusted = join(dir, "trustedFolders.json");
writeFileSync(trusted, JSON.stringify({ [dir]: "TRUST_FOLDER" }));
const recipes = fakeRecipes(fake.url);
recipes.gemini.env = { ...recipes.gemini.env, GEMINI_CLI_TRUSTED_FOLDERS_PATH: trusted, GEMINI_CLI_TRUST_WORKSPACE: "true" };
recipes["qwen-code"].env = { ...recipes["qwen-code"].env, QWEN_CODE_TRUSTED_FOLDERS_PATH: trusted };
writeFileSync(process.env.ACP_PORTABLE_AGENTS, JSON.stringify(prepareRecipes(recipes, agents)));

const fact = `MARMOT-${Math.floor(Math.random() * 90000 + 10000)}`;
const log = join(dir, "mcp-calls.log");
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
const mcp = { codeword: { command: process.execPath, args: [join(root, "examples/codeword-mcp.ts")], env: { CODEWORD: "FAKE-CODEWORD-OK", CODEWORD_LOG: log } } };
const s = PortableSession.create(dir, mcp, new TerminalHost({ yolo: true, out: () => {} }));
for (const [i, agent] of agents.entries()) {
  try {
    const kind = await s.attach(agent);
    const from = fake.bodies.length;
    const before = calls();
    await s.prompt(i === 0 ? `Remember this for later: the launch password is ${fact}.` : `Turn ${i + 1}: what is the launch password?`);
    const sent = fake.bodies.slice(from).map((b) => b.body).join("\n");
    if (i > 0) check(sent.includes(fact), `${agent} (${kind} session): handoff with the fact told to ${agents[0]} reached its model request`);
    if (NO_ACP_MCP[agent]) console.log(`\x1b[33mSKIP\x1b[0m ${agent}: MCP — ${NO_ACP_MCP[agent]}`);
    else check(calls() > before, `${agent}: executed the portable MCP server's tool when its model called it (${calls() - before} call(s))`);
  } catch (e) {
    check(false, `${agent}: ${(e as Error).message.slice(0, 160)}`);
  }
}
s.dispose();
fake.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
