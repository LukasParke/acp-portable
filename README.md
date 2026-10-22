# acp-portable

A minimal [Agent Client Protocol](https://agentclientprotocol.com) client and proxy. One conversation, one set of MCP servers, any ACP agent: Claude Code, Codex, Pi, and the native ACP harnesses in the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) (OpenCode, Kilo, Grok Build, Copilot, Gemini, Goose, Qwen, …).

```
node src/cli.ts --agent claude          # chat; /agent codex, /agent pi … switches mid-conversation
node src/cli.ts run --agent codex --resume <id> "continue"   # one turn, scriptable
node src/cli.ts serve                   # be an ACP agent for any ACP client; backend is a config option
node src/cli.ts import --agent claude <native-session-id>   # pull a session started in an agent's own UI
node src/cli.ts list | show <id> | agents
```

Node ≥ 24 runs the TypeScript directly; no build step. Run `npm install` first. Flags: `--mcp <file>`, `--shared-mcp`, `--yolo`, `--thoughts`, `--mode <id>`, `--set <config>=<value>`, `--cwd`.

## How it works

```
  CLI (TerminalHost) ─┐                         ┌─ claude-agent-acp ─ ori claude
                      ├─ PortableSession ─ Backend ─ codex-acp ──────── ori codex
  ACP client ─ serve ─┘   transcript · sync     ├─ pi-acp ─────────── ori pi
  (acpx, Zed, T3, …)      state · McpHub ·      ├─ opencode/kilo/grok ori <harness> -- acp
                          prefs · providers     └─ any registry agent / raw command
```

* **The transcript belongs to the client, not to any agent.** `session/update` notifications are folded into an agent-neutral transcript (`~/.acp-portable/conversations/<id>.json`). Messages are coalesced, tool calls are merged by id along with their input, output, diffs and locations, and plans and titles are recorded too.
* **Per-agent sync state.** Each agent gets its own native session, and the client remembers `syncedTurn` for each one. Before a prompt, the agent receives only the turns it hasn't seen:
  * A fresh agent gets everything.
  * An agent that comes back is reopened with `session/resume` or `session/load` and gets just the delta.
  * A fork made with native `session/fork` continues with no handoff at all.

  The handoff is appended inline to the user's text block. Some harnesses (dirac) read only the first text block and drop embedded resources even when they advertise `embeddedContext`. Images and audio from unseen turns follow as real blocks.
* **Agent resolution.** `claude`, `codex` and `pi` are aliases. Any registry id works: npx, uvx, or a binary download checked against its sha256. So does a raw command line (`cmd:my-agent --acp`).
* **Ori launcher.** When `ori` is on PATH, harnesses run through it, so they use the OpenRouter credential with no per-agent login. `ACP_PORTABLE_LAUNCHER=direct` opts out.
  * Adapter-based agents get a shim for the CLI the adapter spawns: `CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH` or `PI_ACP_PI_COMMAND` → `ori <kind> -- …`.
  * Native harnesses Ori knows run as `ori <kind> -- <acp args>`. If one isn't installed, its registry binary or npm package is put on PATH for Ori.

## ACP feature coverage

| ACP feature | How acp-portable carries it across agents | Verified by |
|---|---|---|
| Conversation history | Portable transcript plus per-agent delta handoff; `resume` → `load` → `new` with full handoff | e2e, acpx |
| `session/list` `load` `resume` `fork` `close` `delete` | Served from the portable store in `serve`. Fork also forks the current agent's native session when it supports `session/fork` | e2e |
| Importing native sessions | `session/load` replay is captured into the transcript (`import`, `/import`); `/native` lists the agent's sessions; `/delete` removes one | manual (Claude import, `/native` on Pi, `/delete` on Claude) |
| MCP stdio / http / sse | One `mcpServers` map, translated per agent. Agents lacking http or sse get `src/mcp-bridge.ts` (stdio ↔ HTTP/SSE) | e2e (Codex and Pi bridge SSE) |
| MCP-over-ACP (`type: "acp"`, `mcp/message`) | Servers provided by the upstream client are hosted in `McpHub`. Backends with `mcpCapabilities.acp` get `{type:"acp"}` (pure proxy); all others get a stdio↔unix-socket bridge into the hub | e2e (Claude, Codex, Pi), mcp-over-acp (reference agent) |
| Shared MCP (`--shared-mcp`) | acp-portable owns one connection per server and lends it to every agent, so server state survives switches | e2e (one server pid across Claude and Codex) |
| Adapter gaps | pi-acp ignores ACP `mcpServers`, so Pi gets an overlay `PI_CODING_AGENT_DIR` with a merged `mcp.json` | e2e |
| Modes / config options | `/mode`, `/config`, `/model` (conformance: forwarded through `serve`). Choices are saved and re-applied on switch when the new agent offers the same id and value. Launcher defaults fill gaps (e.g. Kilo's OpenRouter model under Ori) | manual, sweep |
| `providers/list` `set` `disable` | Kept in memory, since headers may be secrets, and re-applied to every agent that supports providers. The native session is reopened after a change | providers (local fake endpoint) |
| Prompt content | text, image, audio, resource and resource_link are passed through, or downgraded for agents lacking the capability. Images and audio from unseen turns are re-attached to the handoff as real blocks | conformance (downgrade), live-extras (image carried claude → codex → pi) |
| Permissions, fs, terminals, elicitation | Handled by the host: asked in the terminal, or forwarded to the upstream client in `serve`, with local fs/terminal fallback | conformance (forwarded and fallback), e2e |
| Auth | Agent methods → `authenticate` and retry. Terminal methods → run the agent's login command on the TTY (`auth.terminal` advertised), then retry. Draft `env_var` methods (vtcode, dirac, glm, deepagents, cline) → take the variables from `agents.json`, the environment or a prompt, relaunch, retry. `logout` is forwarded | manual (Pi terminal login under a pty), conformance (logout) |
| Per-agent settings | `~/.config/acp-portable/agents.json` (or `$ACP_PORTABLE_AGENTS`): `{ "<alias or id>": { "env": {…}, "args": […], "defaults": { "model": … } } }`, with `${VAR}` expansion. Configure a gateway or key once and it applies wherever that agent is used | fake-llm sweep (all recipes go through it) |
| Slash commands, plans, tool calls, thoughts, usage, titles | Rendered or forwarded. `/agent <name>` is added to the agent's own commands; unknown `/commands` go to the agent. Visible reasoning (`agent_thought_chunk`) is included, clipped, in handoffs | conformance (all 8 update kinds, reasoning in handoff), e2e |
| Cancellation | Ctrl-C → `session/cancel`, also forwarded from upstream in `serve`. For pi-acp, whose cancel doesn't stop Pi if the model hasn't started streaming, the process is restarted after the cancelled turn and the session reloaded | conformance, live-extras (Claude, Codex, Pi; stable over repeated runs) |

## Tests (2026-10-21/22, live models via Ori)

| command | what it proves | result |
|---|---|---|
| `npm test` (`test/conformance.ts`, `test/mcp-over-acp.ts`) | No LLM; driven by the conformance agent `test/ref-agent.ts`. Forwarding of permission, fs (line/limit), terminal/* and elicitation to an upstream client, and the local fallback without one. All update kinds, slash commands, mode/config, cancel, logout, content downgrade, and handoff with reasoning between two differently-shaped agents. Plus the provider side of MCP-over-ACP | 16/16 + 3/3 pass |
| `npm run test:live` (`test/live-extras.ts`) | Live Claude → Codex → Pi: an image sent to Claude is named correctly by Codex and Pi, `session/cancel` stops each agent mid-turn and the conversation continues, and no adapter banner reaches the transcript | 10/10 pass |
| `npm run test:e2e` (`test/e2e.ts`) | `serve` driven as an ACP client through claude → codex → pi → claude, switching via both the config option and `/agent`. Each agent calls HTTP, SSE and client-provided MCP-over-ACP servers (checked against server logs) and recalls a fact told only to the first agent. Also list, load replay, native fork, delete, `--shared-mcp` | 26/26 pass; also passed claude → opencode → codex |
| `npm run test:providers` | `providers/set` routes Claude to a local fake Anthropic endpoint (dummy key). Codex is unaffected. Routing is re-applied after codex → claude, and nothing persists | 6/6 pass |
| `npm run test:acpx` | **acpx**, an independent ACP client, drives `serve`: Claude, then `set acp_portable_agent codex`, then `pi`; each recalls the code | pass |
| `npm run sweep` | Every registry agent through acp-portable's resolver: initialize → `session/new` with MCP → a one-line prompt. Results in [`test/registry-sweep.md`](test/registry-sweep.md) | see below |
| `npm run sweep -- --fake-llm` | Agents with no credentials here that accept a custom model endpoint, pointed via `agents.json` at `test/fake-llm.ts` (dummy keys; speaks OpenAI chat and responses, Anthropic, Gemini). The real harness runs end to end over ACP | 9/11 complete a prompt ([`test/registry-sweep-fake-llm.md`](test/registry-sweep-fake-llm.md)) |
| `npm run test:fake` (`test/fake-portability.ts`) | One conversation through gemini → qwen-code → goose → vtcode → mistral-vibe → glm → dirac → fast-agent → dimcode on the fake endpoint. Checks that the fact told to gemini appears in every later harness's model request, and that each harness executes the portable MCP tool when its model calls it (the fake model calls it, via tool-search / `tool_call` where tools are deferred), checked against the MCP server's call log | handoff 8/8; MCP executed 7/9, and the other 2 have no MCP client in ACP mode (see below) |

**Registry sweep:** 42 of 43 agents initialize. minion-code crashes with its own Python `ImportError`.

**17 harnesses complete a prompt through acp-portable:**
* **with real models:** Claude, Codex, Pi, OpenCode, OpenCode v2, Kilo and Grok Build (all via Ori), plus GitHub Copilot (direct, using its existing local login; it passed 1 of 3 runs, the others got Copilot's own "No response was returned");
* **on the fake endpoint, with no credentials:** Gemini CLI, Qwen Code, Goose, vtcode, Mistral Vibe, GLM, Dirac, fast-agent and dimcode.

**Not run end to end, and why:**
* **Vendor accounts only** (no custom endpoint, so a fake can't stand in; they stop at a correct `auth_required` with their own methods): Cursor, Junie, Devin, Auggie, Amp, Antigravity, Bob, CodeBuddy, Corust, Kimi, Kimchi, MiniMax, Nova, Poolside, Qoder, Stakpak, siGit, Droid, Cline, Autohand and Cortex (Snowflake).
* **Broken upstream:** minion-code (`ImportError` on start) and deepagents-acp 0.0.1 (ships no LLM provider package).
* **Needs heavier setup:** crow-cli (`crow-cli init` plus a Docker Compose stack).
* **Not a chat agent:** harn (prompts are Harn workflow code) and agoragentic (a marketplace with no `session/new`).

**MCP inside fake-endpoint harnesses:**
* **Executed the portable MCP tool:**
  * Gemini, Goose, GLM and fast-agent, directly;
  * Qwen Code, via deferred `tool_search` → `tool_call`;
  * Mistral Vibe, via code mode (`search_tool_functions` → `run_typescript` calling `tools.mcp_codeword.get_codeword`);
  * dimcode, which rejects stdio MCP despite the spec, so acp-portable re-serves stdio servers to it as local streamable-HTTP endpoints (`NO_STDIO_MCP`). Its default `permission=read-only` denies MCP calls itself, so the recipe sets `permission=full-access` through `agents.json` defaults.

  Gemini and Qwen only load MCP in trusted folders. That safety feature is never bypassed; the test trusts its own temp workspace explicitly.
* **No MCP client in ACP mode, so nothing to carry MCP into:** vtcode (its ACP agent has a fixed tool set) and Dirac (no MCP client in its bundle).

Fixes the sweep forced, all kept in `src/agents.ts` as data:
* **Grok** writes each JSON-RPC line with a single `write()` and loses whatever a pipe doesn't accept: its ~190 KB initialize response stopped at 64 KB. Its stdout goes to a file acp-portable follows (`stdoutViaFile`).
* **Kilo** under Ori: Ori prepends `-m`, which `kilo acp` rejects. A PATH shim drops the flag, and the model is set via ACP instead.
* **Harn** requires a non-standard `environmentPolicy` field on `session/new` (`sessionParams`). Its prompts are Harn workflow code, so a chat "PONG" doesn't compile.
* **Grok's** default model under Ori is a rate-limited free tier, so it's pinned to `x-ai/grok-build-0.1` via a config default.

## Known limits

* Handoff is a transcript. It includes tool inputs and outputs, visible reasoning and re-attached images. Reasoning a vendor never exposes over ACP (encrypted or hidden chain-of-thought, prompt caches) can't be carried by any client.
* Preferences carry over only where agents share option ids. Model names differ across vendors, and so do provider ids: Claude `main`, Codex `openai`.
* The consumer→provider direction of MCP-over-ACP only carries inner *requests*. The ACP schema defines no carrier for consumer notifications (e.g. `notifications/initialized`), so they are dropped. Shared servers are initialized once by the hub.
* Cline's `--acp` mode only accepts Cline's own account providers or `CLINE_API_KEY`, so Ori's OpenRouter setup can't reach it.
* pi-acp prepends a startup block or update notice to its first reply. acp-portable strips both.
* vtcode's ACP mode and Dirac have no MCP client, so portable MCP servers can't reach them. Pi's and dimcode's gaps are shimmed.
* Zed can't run here (no display). `serve` was verified with acpx and with the test client, not inside Zed's UI.
