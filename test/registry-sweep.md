| agent | launcher | reached | protocol caps | result |
|---|---|---|---|---|
| agoragentic-acp | direct | session/new |  | Method not found: session/new [auth methods: ] |
| amp-acp | direct | prompt | load resume mcp:http mcp:sse image embedded | ACP connection closed [auth methods: setup] |
| antigravity-acp | direct | session/new | load resume list mcp:http mcp:sse image embedded | auth_required: Authentication required [auth methods: oauth-personal, oauth-business, gemini-api-key, agent-platform] |
| auggie | direct | session/new | load list image | auth_required: Authentication required: Auggie does not currently support authenticating over ACP. Please run `auggie login` from your terminal then try again. |
| autohand | direct | session/new | load resume list fork mcp:http mcp:sse image embedded | auth_required: Authentication required [auth methods: autohand-install] |
| bob | direct | session/new | load resume list close delete mcp:http image embedded | auth_required: Authentication required [auth methods: sso] |
| claude-acp | ori | done | load resume list fork close delete mcp:http mcp:sse image embedded providers | ✅ PONG |
| cline | ori | session/new | load image | auth_required: Authentication required: Call authenticate before starting a session [auth methods: cline, cline-pass, openai-codex] |
| codebuddy-code | direct | session/new | load mcp:http mcp:sse image embedded | auth_required: Authentication required [auth methods: iOA, external, internal, selfhosted] |
| codex-acp | ori | done | load resume list fork close delete mcp:http image embedded providers | ✅ PONG |
| cortex-code | direct | prompt | load list | stop=end_turn text="\n\nError: Connection error: Error: No Snowflake connection available. Run 'cortex' interactively to set up a connection, " |
| corust-agent | direct | session/new | image | auth_required: Authentication required [auth methods: oauth_browser] |
| crow-cli | direct | prompt | load image embedded | stop=end_turn text="# Welcome!\n👋 Hi there! Thanks for trying out `crow-cli`!\n\nUnfortunately I _don't_ have access to an LLM provider yet, s" |
| cursor | direct | session/new | load list mcp:http mcp:sse image | auth_required: Authentication required [auth methods: cursor_login] |
| deepagents | direct | prompt | load image embedded | Internal error [auth methods: anthropic, openai, deepagents-setup] |
| devin | direct | prompt | load list close delete mcp:http mcp:sse image embedded | auth_required: Please log in to use Devin. Use `/login` to authenticate again. [auth methods: devin-browser] |
| dimcode | direct | session/new | load resume list fork close mcp:http mcp:sse image embedded | auth_required: Authentication required: Provider credentials are required |
| dirac | direct | prompt | load resume close delete image embedded providers | prompt timed out after 180s [auth methods: dirac-provider-setup, openai-codex-oauth, dirac-env] |
| factory-droid | ori | session/new | load resume list close mcp:http mcp:sse image embedded | auth_required: Authentication required: Your code: CPPR-JQCZ Click the "Login" button to authenticate, or set a FACTORY_API_KEY environment variable. [auth methods: device-pairing, factory-api-key] |
| fast-agent | direct | prompt | load resume list mcp:http mcp:sse image embedded | auth_required: Authentication required [auth methods: fast-agent-ai-secrets] |
| gemini | direct | session/new | load mcp:http mcp:sse image embedded | auth_required: Gemini API key is missing or not configured. [auth methods: oauth-personal, gemini-api-key, vertex-ai, gateway] |
| github-copilot-cli | direct | prompt | load list close mcp:http mcp:sse image embedded | stop=end_turn text="Warning: Static system messages and tool definitions exceed the model's usable context budget. Reduce static context or " |
| glm-acp-agent | direct | prompt | load resume list fork close mcp:http image embedded | Internal error [auth methods: z-ai-api-key, z_ai_api_key] |
| goose | direct | session/new | load list close delete mcp:http image embedded | Internal error [auth methods: goose-provider] |
| grok-build | ori | done | load resume list close mcp:http mcp:sse image embedded | ✅ PONG |
| harn | direct | prompt | load resume list close mcp:http mcp:sse image embedded | auth_required: Compilation error: Expected statement separator (`;` or newline), got id(with) at 2:7 [auth methods: none] |
| junie | direct | session/new | load resume list fork close delete mcp:http mcp:sse image embedded providers | auth_required: Authentication is required before this operation can be performed. [auth methods: jetbrains-account, junie-cli] |
| kilo | ori | done | load resume list fork close mcp:http mcp:sse image embedded | ✅ PONG |
| kimchi | direct | session/new | load list close mcp:http | auth_required: Authentication required: no credentials configured for the selected model: auth required. Call session/authenticate to log in, then retry. [auth methods: kimchi-agent, kimchi-agent-us] |
| kimi | direct | session/new | load resume list mcp:http image embedded | auth_required: Authentication required [auth methods: login] |
| minimax-code | direct | session/new | load resume list fork close mcp:http mcp:sse | auth_required: Authentication required: Run `mcode login` and try again. |
| minion-code | direct | initialize | - | ACP connection closed |
| mistral-vibe | direct | session/new | load list fork close image embedded | auth_required: Missing API key for mistral provider. [auth methods: browser-auth] |
| nova | direct | session/new | load resume list fork close delete mcp:http mcp:sse image embedded | auth_required: Click Nova Setup to configure your API keys [auth methods: kore-terminal-auth] |
| opencode | ori | done | load resume list fork close mcp:http mcp:sse image embedded | ✅ PONG |
| opencode-v2 | ori | done | load resume list fork close delete mcp:http image embedded | ✅ PONG |
| pi-acp | ori | done | load list delete image | ✅ 1.3.0). Run: `npm i -g @earendil-works/pi-coding-agent`
PONG |
| poolside | direct | session/new | load list close delete image | auth_required: Authentication required |
| qoder | direct | session/new | load list mcp:http mcp:sse image embedded | auth_required: Authentication required: Authentication is required. [auth methods: qodercli-login, qoder-personal-access-token] |
| qwen-code | direct | session/new | load resume list mcp:http mcp:sse image embedded | auth_required: Authentication required: Use Qwen Code CLI to authenticate first. [auth methods: openai] |
| sigit | direct | prompt | load resume list fork close delete mcp:http image embedded | stop=end_turn text="No on-device model is loaded. Run `/load` to load the selected model, or `/models` to choose one." |
| stakpak | direct | session/new | load mcp:http mcp:sse image embedded | auth_required: Authentication required [auth methods: stakpak] |
| vtcode | direct | prompt | load mcp:http image embedded | Internal error [auth methods: oauth-openai, oauth-openrouter, terminal-login, env-api-keys, env-base-urls] |
