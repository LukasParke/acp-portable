// Debug helper: resolve an agent, initialize, open a session, print what it offers.
//   node scripts/probe.ts <agent>
import { resolveAgent } from "../src/agents.ts";
import { Backend } from "../src/backend.ts";
import { TerminalHost } from "../src/terminal-host.ts";

const spec = process.argv[2];
const a = await resolveAgent(spec);
console.error("cmd", a.command, a.args.join(" "), a.launcher);
const b = await Backend.start(a, new TerminalHost({ out: () => {} }), process.cwd());
const init = b.init;
console.log(JSON.stringify({ spec, launcher: a.launcher, info: init.agentInfo, caps: init.agentCapabilities, auth: init.authMethods }, null, 1));
const s = await b.rpc.request("session/new", { cwd: process.cwd(), mcpServers: [] });
console.log("session", s.sessionId, "modes:", s.modes?.availableModes?.map((m) => m.id));
for (const o of s.configOptions ?? []) {
  const values = o.type === "select" ? o.options.flatMap((x) => ("options" in x ? x.options : [x])).map((x) => x.value) : [];
  console.log(`config ${o.id} (${o.category ?? "-"}) = ${o.currentValue}; ${values.length} values: ${values.slice(0, 8).join(", ")}`);
}
b.close();
process.exit(0);
