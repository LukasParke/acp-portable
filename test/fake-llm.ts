// A fake LLM endpoint for exercising real agent harnesses without real
// credentials. It answers REPLY, but first calls the codeword MCP tool when the
// harness offers it (see decide()). Speaks OpenAI chat
// completions + responses, Anthropic messages, and Gemini generateContent,
// plus their model listings. Used by test/providers.ts and the sweep's --fake-llm.
//   node test/fake-llm.ts [port]       (or import { startFakeLlm })
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const REPLY = "PONG";
const MODEL = "fake-model";

/**
 * acp-portable agents.json settings that point registry agents accepting a
 * custom model endpoint at this fake, with dummy keys — exactly how a user
 * would configure a real gateway. Found per agent from its auth methods/docs.
 */
export type FakeRecipe = { env?: Record<string, string>; args?: string[]; defaults?: Record<string, string>; setup?: string[] };
export const fakeRecipes = (u: string): Record<string, FakeRecipe> => ({
  "qwen-code": { env: { OPENAI_API_KEY: "dummy", OPENAI_BASE_URL: `${u}/v1`, OPENAI_MODEL: "fake-model" }, args: ["--auth-type", "openai"] },
  goose: { env: { GOOSE_PROVIDER: "openai", GOOSE_MODEL: "fake-model", OPENAI_HOST: u, OPENAI_API_KEY: "dummy" } },
  vtcode: { env: { OPENAI_API_KEY: "dummy", OPENAI_BASE_URL: `${u}/v1`, VTCODE_PROVIDER: "openai", VTCODE_MODEL: "fake-model" } },
  deepagents: { env: { ANTHROPIC_API_KEY: "dummy", ANTHROPIC_BASE_URL: u } },
  dirac: { env: { DIRAC_PROVIDER: "openai", DIRAC_MODEL: "fake-model", DIRAC_API_KEY: "dummy", DIRAC_BASE_URL: `${u}/v1` } },
  gemini: { env: { GEMINI_API_KEY: "dummy", GOOGLE_GEMINI_BASE_URL: u, GEMINI_MODEL: "fake-model" } },
  "fast-agent": { env: { FAST_AGENT_MODEL: "generic.fake-model", GENERIC_API_KEY: "dummy", GENERIC_BASE_URL: `${u}/v1` } },
  "glm-acp-agent": { env: { Z_AI_API_KEY: "dummy", ACP_GLM_BASE_URL: `${u}/v1`, ACP_GLM_MODEL: "fake-model" } },
  "mistral-vibe": {
    env: {
      FAKE_API_KEY: "dummy",
      VIBE_PROVIDERS: JSON.stringify([{ name: "fake", api_base: `${u}/v1`, api_key_env_var: "FAKE_API_KEY", backend: "generic" }]),
      VIBE_MODELS: JSON.stringify([{ name: "fake-model", provider: "fake", alias: "fake" }]),
      VIBE_ACTIVE_MODEL: "fake",
    },
  },
  "crow-cli": { env: { OPENAI_API_KEY: "dummy", OPENAI_BASE_URL: `${u}/v1`, LLM_MODEL: "fake-model" } },
  // dimcode keeps providers only under ~/.dimcode, so it gets an isolated HOME,
  // provisioned once with its own CLI. The real node bin goes first on PATH
  // because version-manager shims (mise, asdf) resolve config from HOME.
  dimcode: (() => {
    const home = mkdtempSync(join(tmpdir(), "fake-dimcode-home-"));
    const env = { HOME: home, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` };
    // dimcode's default permission level (read-only) denies MCP tool calls itself, without asking the client.
    return { env, defaults: { permission: "full-access" }, setup: ["npx", "-y", "dimcode@0.5.21", "provider", "add", "fake", "--adapter", "openai-compatible", "--base-url", `${u}/v1`, "--model", "fake-model", "--api-key", "dummy"] };
  })(),
});

/** Run each recipe's one-time setup command in its env; returns agents.json content. */
export function prepareRecipes(recipes: Record<string, FakeRecipe>, only?: string[]): Record<string, Omit<FakeRecipe, "setup">> {
  for (const [id, r] of Object.entries(recipes)) {
    if (!r.setup || (only && !only.includes(id))) continue;
    execFileSync(r.setup[0], r.setup.slice(1), { env: { ...process.env, ...r.env }, stdio: ["ignore", "ignore", "inherit"], timeout: 300_000 });
  }
  return Object.fromEntries(Object.entries(recipes).map(([id, { setup: _, ...rest }]) => [id, rest]));
}

export async function startFakeLlm(port = 0, reply = REPLY): Promise<{ url: string; seen: string[]; bodies: { url: string; body: string }[]; close: () => void }> {
  const seen: string[] = [];
  const bodies: { url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url}`);
      bodies.push({ url: req.url ?? "", body });
      try {
        route(req, res, body ? JSON.parse(body) : {}, reply);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, bodies, close: () => server.close() };
}

function json(res: ServerResponse, o: unknown) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
}
function sse(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  return (data: unknown, event?: string) => res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

type Tool = { name: string; schema?: { properties?: Record<string, { type?: string; enum?: string[] }>; required?: string[] } };
type Turn = { text: string } | { call: { id: string; name: string; args: Record<string, unknown> } };

/**
 * The fake model's whole "policy": if the harness offers the codeword MCP tool,
 * call it and then answer with its result; if MCP tools are deferred behind a
 * tool-search tool, search for "codeword" first; otherwise just say REPLY.
 * This proves the harness really wired the MCP server through to its model.
 */
function decide(tools: Tool[], last: { name: string; args?: Record<string, unknown>; output: string } | undefined, reply: string): Turn {
  const id = `call_${Date.now()}`;
  const viaMeta = (last?.name === "tool_call" && /codeword/i.test(String(last.args?.name ?? ""))) || (last?.name === "run_typescript" && /codeword/i.test(String(last.args?.code ?? "")));
  if (last && (/codeword/i.test(last.name) || viaMeta)) return finish(tools, `${reply} ${last.output.slice(0, 200)}`);
  const codeword = tools.find((t) => /get_codeword/.test(t.name));
  if (codeword) return { call: { id, name: codeword.name, args: {} } };
  // Deferred tools: search, then invoke what was found (directly or via a tool_call meta-tool).
  const search = tools.find((t) => /tool_?search|search_?tools?(_functions)?\b/i.test(t.name));
  const found = last && last.name === search?.name ? last.output.match(/[\w.-]*get_codeword/)?.[0] : undefined;
  if (found && tools.some((t) => t.name === "tool_call")) return { call: { id, name: "tool_call", args: { name: found, arguments: {} } } };
  // Code mode (mistral-vibe): call the discovered function from TypeScript.
  if (found && tools.some((t) => t.name === "run_typescript")) {
    return { call: { id, name: "run_typescript", args: { code: `async function main() {\n  return await tools.${found}({});\n}` } } };
  }
  if (search && last?.name !== search.name) {
    const props = search.schema?.properties ?? {};
    const keys = "query" in props ? ["query"] : (search.schema?.required?.length ? search.schema.required : Object.keys(props).slice(0, 1)).filter((k) => (props[k]?.type ?? "string") === "string");
    return { call: { id, name: search.name, args: Object.fromEntries((keys.length ? keys : ["query"]).map((k) => [k, "codeword"])) } };
  }
  return finish(tools, reply);
}

/** Harnesses that require a completion tool call to end a turn (dirac: `respond`) get one. */
function finish(tools: Tool[], text: string): Turn {
  const done = tools.find((t) => /^(respond|attempt_completion)$/.test(t.name));
  if (!done) return { text };
  const props = (done.schema?.properties ?? { result: {} }) as Record<string, { type?: string; enum?: string[] }>;
  const keys = done.schema?.required?.length ? done.schema.required : Object.keys(props).slice(0, 1);
  // Enum fields get a valid choice (dirac's respond: operation="complete"); text fields get the reply.
  const value = (k: string) => (props[k]?.enum ? (props[k].enum!.includes("complete") ? "complete" : props[k].enum![0]) : text);
  return { call: { id: `call_${Date.now()}`, name: done.name, args: Object.fromEntries(keys.map((k) => [k, value(k)])) } };
}

const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function route(req: IncomingMessage, res: ServerResponse, body: Record<string, any>, reply: string) {
  const url = req.url ?? "";
  const model = body.model ?? MODEL;
  const now = Math.floor(Date.now() / 1000);

  // Gemini: /v1beta/models/m:generateContent | :streamGenerateContent
  if (url.includes(":streamGenerateContent") || url.includes(":generateContent")) {
    const tools: Tool[] = (body.tools ?? []).flatMap((t: any) => (t.functionDeclarations ?? []).map((f: any) => ({ name: f.name, schema: f.parametersJsonSchema ?? f.parameters })));
    const lastParts = body.contents?.at(-1)?.parts ?? [];
    const fr = lastParts.find((p: any) => p.functionResponse)?.functionResponse;
    const turn = decide(tools, fr ? { name: fr.name, output: str(fr.response) } : undefined, reply);
    const part = "text" in turn ? { text: turn.text } : { functionCall: { name: turn.call.name, args: turn.call.args } };
    const chunk = { candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 }, modelVersion: MODEL };
    if (url.includes(":stream")) {
      sse(res)(chunk);
      res.end();
    } else json(res, chunk);
    return;
  }
  if (url.includes(":countTokens")) return json(res, { totalTokens: 10 });
  if (/\/v1beta\/models/.test(url)) return json(res, { models: [{ name: `models/${MODEL}`, displayName: MODEL, inputTokenLimit: 1_000_000, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent"] }] });

  // Anthropic messages
  if (url.startsWith("/v1/messages")) {
    if (url.includes("count_tokens")) return json(res, { input_tokens: 10 });
    const tools: Tool[] = (body.tools ?? []).filter((t: any) => t.name).map((t: any) => ({ name: t.name, schema: t.input_schema }));
    const msgs = body.messages ?? [];
    const result = Array.isArray(msgs.at(-1)?.content) ? msgs.at(-1).content.find((c: any) => c.type === "tool_result") : undefined;
    const use = result && msgs.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((c: any) => c.type === "tool_use" && c.id === result.tool_use_id);
    const turn = decide(tools, use ? { name: use.name, output: str(result.content) } : undefined, reply);
    const block = "text" in turn ? { type: "text", text: turn.text } : { type: "tool_use", id: turn.call.id, name: turn.call.name, input: turn.call.args };
    const stop = "text" in turn ? "end_turn" : "tool_use";
    const msg = { id: "msg_fake", type: "message", role: "assistant", model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    if (!body.stream) return json(res, { ...msg, content: [block], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 1 } });
    const send = sse(res);
    send({ type: "message_start", message: msg }, "message_start");
    if (block.type === "text") {
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }, "content_block_delta");
    } else {
      send({ type: "content_block_start", index: 0, content_block: { ...block, input: {} } }, "content_block_start");
      send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }, "content_block_delta");
    }
    send({ type: "content_block_stop", index: 0 }, "content_block_stop");
    send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }, "message_delta");
    send({ type: "message_stop" }, "message_stop");
    res.end();
    return;
  }

  // OpenAI responses API
  if (/\/responses\b/.test(url)) {
    const tools: Tool[] = (body.tools ?? []).filter((t: any) => t.type === "function").map((t: any) => ({ name: t.name, schema: t.parameters }));
    const input = Array.isArray(body.input) ? body.input : [];
    const out = input.at(-1)?.type === "function_call_output" ? input.at(-1) : undefined;
    const call = out && input.find((x: any) => x.type === "function_call" && x.call_id === out.call_id);
    const turn = decide(tools, call ? { name: call.name, output: str(out.output) } : undefined, reply);
    const item = "text" in turn
      ? { id: "msg_fake", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: turn.text, annotations: [] }] }
      : { id: "fc_fake", type: "function_call", status: "completed", call_id: turn.call.id, name: turn.call.name, arguments: JSON.stringify(turn.call.args) };
    const response = { id: "resp_fake", object: "response", created_at: now, model, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
    if (!body.stream) return json(res, response);
    const send = sse(res);
    send({ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, "response.created");
    send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...("content" in item ? { content: [] } : { arguments: "" }) } }, "response.output_item.added");
    if ("content" in item) {
      const text = item.content![0].text;
      send({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "" } }, "response.content_part.added");
      send({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text }, "response.output_text.delta");
      send({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text }, "response.output_text.done");
    } else {
      send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments }, "response.function_call_arguments.delta");
      send({ type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: item.arguments }, "response.function_call_arguments.done");
    }
    send({ type: "response.output_item.done", output_index: 0, item }, "response.output_item.done");
    send({ type: "response.completed", response }, "response.completed");
    res.end();
    return;
  }

  // OpenAI chat completions
  if (/\/chat\/completions\b/.test(url) || /\/completions\b/.test(url)) {
    const tools: Tool[] = (body.tools ?? []).map((t: any) => ({ name: t.function?.name ?? t.name, schema: t.function?.parameters }));
    const msgs: any[] = body.messages ?? [];
    // The newest tool result since the last assistant turn (harnesses may add reminders after it).
    const lastAssistant = msgs.findLastIndex((m) => m.role === "assistant");
    const tail = msgs.slice(lastAssistant + 1).findLast((m) => m.role === "tool");
    const call = tail && msgs.flatMap((m: any) => m.tool_calls ?? []).find((c: any) => c.id === tail.tool_call_id);
    const args = (() => { try { return JSON.parse(call?.function?.arguments ?? "{}"); } catch { return {}; } })();
    const turn = decide(tools, call ? { name: call.function.name, args, output: str(tail.content) } : undefined, reply);
    const base = { id: "chatcmpl-fake", created: now, model };
    const toolCall = "call" in turn ? { index: 0, id: turn.call.id, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } } : undefined;
    const finish = toolCall ? "tool_calls" : "stop";
    if (!body.stream) {
      const message = toolCall ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: (turn as { text: string }).text };
      return json(res, { ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    }
    const send = sse(res);
    send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: toolCall ? { tool_calls: [toolCall] } : { content: (turn as { text: string }).text }, finish_reason: null }] });
    send({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    send("[DONE]");
    res.end();
    return;
  }

  // Model listings (OpenAI & Anthropic shapes merged)
  if (/\/models\b/.test(url)) {
    return json(res, { object: "list", data: [{ id: MODEL, object: "model", created: now, owned_by: "fake", type: "model", display_name: MODEL, created_at: "2025-01-01T00:00:00Z" }], has_more: false, first_id: MODEL, last_id: MODEL });
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `fake-llm: no route for ${req.method} ${url}` } }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await startFakeLlm(Number(process.argv[2] ?? 0));
  console.error(`fake LLM on ${f.url}`);
}
