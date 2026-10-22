// providers/* (unstable ACP): route an agent's LLM traffic to a local fake
// Anthropic-compatible endpoint with providers/set (dummy key, no real
// credentials), and check that acp-portable re-applies the routing when the
// conversation returns to that agent after a switch.
//   node test/providers.ts
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortableSession } from "../src/portable.ts";
import { TerminalHost } from "../src/terminal-host.ts";

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${what}`);
  if (!ok) failures++;
};

// Minimal Anthropic Messages API: every request gets a streamed canned answer.
const REPLY = "ROUTED-VIA-LOCAL-PROVIDER";
const seen: string[] = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/v1/models")) {
      const models = ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-5"].map((id) => ({ type: "model", id, display_name: id, created_at: "2025-01-01T00:00:00Z" }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: models, has_more: false, first_id: models[0].id, last_id: models.at(-1)!.id }));
      return;
    }
    if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    const model = (() => { try { return JSON.parse(body).model; } catch { return "fake"; } })();
    const msg = { id: "msg_fake", type: "message", role: "assistant", model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    if (!body.includes('"stream":true')) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...msg, content: [{ type: "text", text: REPLY }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: msg });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: REPLY } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
    ev("message_stop", {});
    res.end();
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

let text = "";
const s = PortableSession.create(mkdtempSync(join(tmpdir(), "acpp-prov-")), {}, new TerminalHost({ yolo: true, out: () => {} }));
s.onUpdate = (u) => { if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text; };
await s.attach("claude");
const main = (await s.listProviders()).find((p) => p.current)!;
const original = main.current!.baseUrl;
check(!!main.current, `providers/list: ${main.providerId} → ${main.current?.apiType} ${original}`);

await s.setProvider({ providerId: main.providerId, apiType: "anthropic", baseUrl, headers: { "x-api-key": "dummy-not-a-secret" } });
check((await s.listProviders()).find((p) => p.providerId === main.providerId)?.current?.baseUrl === baseUrl, "providers/set: routing updated");
text = "";
await s.prompt("Say anything.");
check(text.includes(REPLY) && seen.length > 0, `claude answered from the local provider (${seen.length} requests, e.g. ${seen.find((x) => x.includes("messages"))})`);

await s.attach("codex"); // codex has no "main" provider; it keeps its own routing
text = "";
await s.prompt("Reply with exactly: OK");
check(!text.includes(REPLY), "codex unaffected (different provider ids)");
const before = seen.length;
text = "";
await s.attach("claude");
await s.prompt("Say anything again.");
check(text.includes(REPLY) && seen.length > before, `codex -> claude: routing re-applied on attach (${seen.length - before} new requests)`);
s.dispose();

// The override lives in the agent process only; a fresh session is back to normal.
const fresh = PortableSession.create(mkdtempSync(join(tmpdir(), "acpp-prov-")), {}, new TerminalHost({ out: () => {} }));
await fresh.attach("claude");
check((await fresh.listProviders()).find((p) => p.providerId === main.providerId)?.current?.baseUrl === original, `fresh claude session uses ${original} again (nothing persisted)`);
fresh.dispose();
fake.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
