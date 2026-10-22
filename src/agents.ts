// Resolve an agent spec ("claude", "codex", "pi", any ACP registry id, or a raw
// command line) into a spawnable command. The ACP registry is the source of
// truth for "every native ACP agent", so new agents work without code changes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export type AgentCommand = {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  launcher: "ori" | "direct";
  /** Session config defaults this launch needs (applied unless the user chose otherwise). */
  defaults?: Record<string, string>;
  /** Write the agent's stdout to a file we follow, for agents that drop data on partial pipe writes. */
  stdoutViaFile?: boolean;
  /** Extra (non-standard) fields an agent requires on session/new|load|resume|fork. */
  sessionParams?: Record<string, unknown>;
};

// harn refuses sessions without an explicit environment policy; "inherited" is
// what every other agent does implicitly (children see this process's environment).
const SESSION_PARAMS: Record<string, Record<string, unknown>> = { harn: { environmentPolicy: { kind: "inherited" } } };

// grok writes each JSON-RPC line with one write() and loses whatever a pipe
// doesn't accept (its ~190 KB initialize response stops at 64 KB). Regular
// files take the whole write.
const STDOUT_VIA_FILE = new Set(["grok-build"]);

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "acp-portable");

// Friendly names -> registry ids. Anything else is looked up in the registry as-is.
export const ALIASES: Record<string, string> = {
  claude: "claude-acp",
  "claude-code": "claude-acp",
  codex: "codex-acp",
  pi: "pi-acp",
  copilot: "github-copilot-cli",
  qwen: "qwen-code",
  droid: "factory-droid",
};

type Registry = { agents: RegistryAgent[] };
type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    uvx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<string, { archive: string; cmd: string; args?: string[]; env?: Record<string, string>; sha256?: string }>;
  };
};

export async function loadRegistry(): Promise<Registry> {
  const file = join(CACHE, "registry.json");
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < 6 * 3600_000;
  if (!fresh) {
    try {
      const res = await fetch(REGISTRY_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(file, await res.text());
    } catch (err) {
      if (!existsSync(file)) throw new Error(`cannot fetch ACP registry: ${err}`);
    }
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function platformKey(): string {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform as string] ?? process.platform;
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch as string] ?? process.arch;
  return `${os}-${arch}`;
}

/**
 * Per-agent user settings, keyed by alias, registry id or raw command line:
 *   ~/.config/acp-portable/agents.json  (or $ACP_PORTABLE_AGENTS)
 *   { "qwen": { "env": { "OPENAI_API_KEY": "${MY_KEY}" }, "args": [], "defaults": { "model": "x" } } }
 * `${VAR}` in env values is read from this process's environment.
 */
type AgentSettings = { env?: Record<string, string>; args?: string[]; defaults?: Record<string, string> };
function agentSettings(spec: string, id: string): AgentSettings {
  const file = process.env.ACP_PORTABLE_AGENTS ?? join(homedir(), ".config", "acp-portable", "agents.json");
  if (!existsSync(file)) return {};
  const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, AgentSettings>;
  const s = all[spec] ?? all[id] ?? {};
  const env = Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? "")]));
  return { ...s, env };
}

export async function resolveAgent(spec: string): Promise<AgentCommand> {
  const cmd = await resolveBase(spec);
  const user = agentSettings(spec, cmd.id);
  return {
    ...cmd,
    args: [...cmd.args, ...(user.args ?? [])],
    env: { ...cmd.env, ...user.env },
    defaults: { ...cmd.defaults, ...user.defaults },
  };
}

async function resolveBase(spec: string): Promise<AgentCommand> {
  // Raw command: "cmd:my-agent --acp" or anything containing a space / path.
  if (spec.startsWith("cmd:") || spec.includes(" ") || spec.includes("/")) {
    const line = spec.replace(/^cmd:/, "").trim();
    const [command, ...args] = line.split(/\s+/);
    // The whole command line is the id, so differently-configured instances stay distinct agents.
    return { id: line, name: command.split("/").pop()!, command, args, env: {}, launcher: "direct" };
  }
  const id = ALIASES[spec] ?? spec;
  const registry = await loadRegistry();
  const entry = registry.agents.find((a) => a.id === id);
  if (!entry) {
    const known = [...Object.keys(ALIASES), ...registry.agents.map((a) => a.id)].join(", ");
    throw new Error(`unknown agent "${spec}". Known: ${known}`);
  }
  const cmd = (await viaOri(entry)) ?? (await directCommand(entry));
  return { ...cmd, stdoutViaFile: STDOUT_VIA_FILE.has(entry.id) || undefined, sessionParams: SESSION_PARAMS[entry.id] };
}

async function directCommand(entry: RegistryAgent): Promise<AgentCommand> {
  const { id, name, distribution: d } = entry;
  const base = { id, name, launcher: "direct" as const };
  if (d.npx) return { ...base, command: "npx", args: ["-y", d.npx.package, ...(d.npx.args ?? [])], env: d.npx.env ?? {} };
  if (d.uvx) return { ...base, command: "uvx", args: [d.uvx.package, ...(d.uvx.args ?? [])], env: d.uvx.env ?? {} };
  const bin = d.binary?.[platformKey()];
  if (!bin) throw new Error(`${id} has no distribution for ${platformKey()}`);
  const dir = join(CACHE, "bin", id, entry.version);
  const cmd = join(dir, bin.cmd);
  if (!existsSync(cmd)) await installBinary(bin.archive, bin.sha256, dir);
  chmodSync(cmd, 0o755);
  return { ...base, command: cmd, args: bin.args ?? [], env: bin.env ?? {} };
}

// Ori (https://openrouter.ai) launches harnesses with OpenRouter credentials.
// Adapters that wrap a CLI get a shim for that CLI; ACP-native harnesses Ori
// knows are started as `ori <kind> -- <acp args>`. Set ACP_PORTABLE_LAUNCHER=direct to opt out.
const ORI_ADAPTERS: Record<string, { kind: string; env: string }> = {
  "claude-acp": { kind: "claude", env: "CLAUDE_CODE_EXECUTABLE" },
  "codex-acp": { kind: "codex", env: "CODEX_PATH" },
  "pi-acp": { kind: "pi", env: "PI_ACP_PI_COMMAND" },
};
const ORI_NATIVE: Record<string, string> = {
  opencode: "opencode", "opencode-v2": "opencode", kilo: "kilo", cline: "cline", "factory-droid": "droid", "grok-build": "grok",
};

// Ori prepends `-m <model>` for these harnesses, but their `acp` subcommand rejects it.
// A same-named shim earlier on PATH drops the flag, and the model Ori would have
// chosen is selected through the ACP `model` config option instead.
const ORI_DROP_MODEL_FLAG: Record<string, Record<string, string>> = { kilo: { model: "openrouter/openrouter/auto" } };
// Harnesses whose default model under Ori is a rate-limited free tier.
const ORI_DEFAULTS: Record<string, Record<string, string>> = { grok: { model: "x-ai/grok-build-0.1" } };

function dropModelShim(bin: string): string {
  const dir = join(CACHE, "ori-shims", `drop-model-${bin}`);
  mkdirSync(dir, { recursive: true });
  const self = join(dir, bin);
  writeFileSync(self, `#!/bin/sh
[ "$1" = "-m" ] && shift 2
# exec the next ${bin} on PATH after this shim
IFS=:; for d in $PATH; do [ "$d" = "${dir}" ] && continue; [ -x "$d/${bin}" ] && exec "$d/${bin}" "$@"; done
echo "${bin} not found" >&2; exit 127
`);
  chmodSync(self, 0o755);
  return dir;
}

let oriKinds: Promise<Set<string> | undefined> | undefined;
/** Harness kinds Ori can launch right now, or undefined when Ori isn't usable. */
function oriLaunchable(): Promise<Set<string> | undefined> {
  oriKinds ??= (async () => {
    if (process.env.ACP_PORTABLE_LAUNCHER === "direct") return undefined;
    try {
      const out = JSON.parse(execFileSync("ori", ["harness", "list", "--json"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
      return new Set<string>(out.data.launchable.filter((h: any) => h.installed).map((h: any) => h.kind));
    } catch {
      return undefined;
    }
  })();
  return oriKinds;
}

async function viaOri(entry: RegistryAgent): Promise<AgentCommand | undefined> {
  const kinds = await oriLaunchable();
  if (!kinds) return;
  const adapter = ORI_ADAPTERS[entry.id];
  if (adapter && kinds.has(adapter.kind)) {
    const shim = join(CACHE, "ori-shims", `ori-${adapter.kind}`);
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, `#!/bin/sh\nexec ori ${adapter.kind} -- "$@"\n`);
    chmodSync(shim, 0o755);
    const direct = await directCommand(entry);
    return { ...direct, launcher: "ori", env: { ...direct.env, [adapter.env]: shim } };
  }
  const native = ORI_NATIVE[entry.id];
  const bin = entry.distribution.binary?.[platformKey()];
  if (!native || (!kinds.has(native) && !bin && !entry.distribution.npx)) return;
  const npx = entry.distribution.npx;
  const env: Record<string, string> = { ...(bin?.env ?? npx?.env ?? {}) };
  if (!kinds.has(native)) {
    // Not installed: put the registry's build on PATH for Ori — the verified binary
    // if there is one, otherwise the npm package installed into our cache.
    const binDir = bin ? dirname((await directCommand({ ...entry, distribution: { binary: entry.distribution.binary } })).command) : installNpm(entry.id, npx!.package);
    env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
  }
  const defaults = ORI_DROP_MODEL_FLAG[native] ?? ORI_DEFAULTS[native];
  if (ORI_DROP_MODEL_FLAG[native]) env.PATH = `${dropModelShim(native)}${delimiter}${env.PATH ?? process.env.PATH}`;
  const args = bin?.args ?? npx?.args ?? [];
  return { id: entry.id, name: entry.name, launcher: "ori", command: "ori", args: [native, "--", ...args], env, defaults };
}

function installNpm(id: string, pkg: string): string {
  const prefix = join(CACHE, "npm", id, pkg.replace(/[^\w.@-]/g, "_"));
  const bin = join(prefix, "node_modules", ".bin");
  if (!existsSync(bin)) {
    process.stderr.write(`[acp-portable] installing ${pkg}\n`);
    execFileSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", pkg], { stdio: ["ignore", "ignore", "inherit"] });
  }
  return bin;
}

async function installBinary(url: string, sha256: string | undefined, dir: string) {
  process.stderr.write(`[acp-portable] downloading ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(buf).digest("hex");
  if (sha256 && digest !== sha256) throw new Error(`sha256 mismatch for ${url}`);
  mkdirSync(dir, { recursive: true });
  const name = url.split("/").pop()!;
  const archive = join(dir, name);
  writeFileSync(archive, buf);
  if (name.endsWith(".zip")) execFileSync("unzip", ["-oq", archive, "-d", dir]);
  else if (/\.tar(\.\w+)?$|\.tgz$/.test(name)) execFileSync("tar", ["-xf", archive, "-C", dir]);
  else chmodSync(archive, 0o755); // bare executable
}
