/**
 * pi ↔ ai.vechkabaz.com: registers the models, adds web_search and web_fetch, and
 * migrates any hand-written provider entry for this server out of models.json
 * (models.json overrides extension providers, so a stale entry would win).
 */
import { execSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VERSION = "0.1.0";
const BASE = (process.env.VECHKABAZ_URL ?? "https://ai.vechkabaz.com/api/v1").replace(/\/$/, "");
const HOST = new URL(BASE).host;
const PROVIDER = "vechkabaz";
const DEFAULT_MODEL = "coder-max";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const KEY_FILE = join(AGENT_DIR, "vechkabaz.json");
const HEADERS = { "User-Agent": `pi-vechkabaz/${VERSION}` };

/** What each server model can do; ids the server lists but this table lacks get defaults. */
const PROFILES: Record<string, { name: string; image: boolean; ctx: number }> = {
  "coder-max": { name: "coder-max (careful, 27B)", image: true, ctx: 131072 },
  coder: { name: "coder (fast)", image: true, ctx: 262144 },
  deep: { name: "deep (largest)", image: false, ctx: 32768 },
  "fable-711": { name: "fable-711 (peer machine)", image: false, ctx: 32768 },
  uncensored: { name: "uncensored", image: true, ctx: 131072 },
};

// The server accepts off|low|medium|high|xhigh (plus minimal/none aliases).
const THINKING = { off: "off", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };

function toModel(id: string, ctx?: number) {
  const p = PROFILES[id];
  const contextWindow = ctx ?? p?.ctx ?? 32768;
  return {
    id,
    name: p?.name ?? id,
    reasoning: true,
    thinkingLevelMap: THINKING,
    input: (p?.image ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    // The server clamps output to 32k or half the window, whichever is smaller.
    maxTokens: Math.min(32768, Math.floor(contextWindow / 2)),
    compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" as const },
  };
}

/** A pi apiKey spec — literal, $VAR / ${VAR}, or !command — to the key itself. */
function resolveKey(spec: string | undefined): string | undefined {
  if (!spec) return process.env.VECHKABAZ_API_KEY;
  if (spec.startsWith("!")) return execSync(spec.slice(1), { encoding: "utf8", shell: "/bin/sh" }).trim() || undefined;
  const env = /^\$\{?(\w+)\}?$/.exec(spec);
  return env ? process.env[env[1]!] : spec;
}

function readJson(path: string): Record<string, any> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Backs up, then writes. Returns the backup path. */
function rewrite(path: string, data: unknown): string {
  const backup = `${path}.bak-vechkabaz-${Date.now()}`;
  copyFileSync(path, backup);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return backup;
}

function saveKeySpec(spec: string) {
  writeFileSync(KEY_FILE, JSON.stringify({ apiKey: spec }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
}

/**
 * Moves any models.json provider pointing at this server into this extension:
 * keeps its apiKey spec as-is, drops the stale entry, and repoints settings
 * defaults that referenced it. Everything touched is backed up first.
 */
function migrate(): string[] {
  const notes: string[] = [];
  const modelsPath = join(AGENT_DIR, "models.json");
  let models: Record<string, any> | undefined;
  try {
    models = readJson(modelsPath);
  } catch {
    return [`pi-vechkabaz: ${modelsPath} isn't plain JSON, so it was left alone. Remove any ${HOST} entry from it by hand.`];
  }
  const providers = (models?.providers ?? {}) as Record<string, any>;
  const ours = Object.keys(providers).filter((name) => {
    try {
      return new URL(providers[name].baseUrl).host === HOST;
    } catch {
      return false;
    }
  });
  if (ours.length === 0) return notes;

  const spec = ours.map((n) => providers[n].apiKey).find((k) => typeof k === "string" && k);
  if (spec && !readJson(KEY_FILE)?.apiKey) saveKeySpec(spec);
  for (const n of ours) delete providers[n];
  notes.push(
    `pi-vechkabaz: replaced your ${ours.join(", ")} entry in models.json with the maintained one` +
      `${spec ? " (kept your API key)" : ""}. Backup: ${rewrite(modelsPath, models)}`,
  );

  const settingsPath = join(AGENT_DIR, "settings.json");
  const settings = readJson(settingsPath);
  if (settings && ours.includes(settings.defaultProvider)) {
    settings.defaultProvider = PROVIDER;
    if (!(settings.defaultModel in PROFILES)) settings.defaultModel = DEFAULT_MODEL;
    notes.push(`pi-vechkabaz: default model is now ${PROVIDER}/${settings.defaultModel}. Backup: ${rewrite(settingsPath, settings)}`);
  }
  return notes;
}

/** A fresh install with no default gets this server's default model. */
function setDefaultIfUnset(): string | undefined {
  const settingsPath = join(AGENT_DIR, "settings.json");
  const settings = readJson(settingsPath) ?? {};
  if (settings.defaultProvider) return undefined;
  settings.defaultProvider = PROVIDER;
  settings.defaultModel = DEFAULT_MODEL;
  if (existsSync(settingsPath)) rewrite(settingsPath, settings);
  else writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return `pi-vechkabaz: default model set to ${PROVIDER}/${DEFAULT_MODEL}.`;
}

async function api(path: string, key: string | undefined, signal?: AbortSignal): Promise<any> {
  if (!key) throw new Error("no API key yet: run /vechkabaz-key");
  const res = await fetch(`${BASE}${path}`, {
    headers: { ...HEADERS, Authorization: `Bearer ${key}` },
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? body?.error ?? `HTTP ${res.status}`);
  return body;
}

export default async function (pi: ExtensionAPI) {
  const notes = migrate();
  let spec: string | undefined = readJson(KEY_FILE)?.apiKey;

  // Live list from the server so renamed or retired models never go stale here.
  let modelList = [toModel("coder-max"), toModel("coder")];
  try {
    const listed = await api("/models", resolveKey(spec), AbortSignal.timeout(8_000));
    modelList = listed.data.map((m: any) => toModel(m.id, m.context_length ?? undefined));
  } catch {
    // Offline or no key yet: the built-in pair is enough to start.
  }

  const register = () =>
    pi.registerProvider(PROVIDER, {
      name: "Vechkabaz",
      baseUrl: BASE,
      api: "openai-completions",
      apiKey: spec ?? "$VECHKABAZ_API_KEY",
      authHeader: true,
      headers: HEADERS,
      models: modelList,
    });
  register();

  const askForKey = async (ctx: any): Promise<boolean> => {
    const key = (await ctx.ui.input("Vechkabaz API key", "hl_… from Settings → API access on the site"))?.trim();
    if (!key?.startsWith("hl_")) {
      ctx.ui.notify("No key saved. Run /vechkabaz-key when you have one.", "warning");
      return false;
    }
    try {
      await api("/models", key);
    } catch (e) {
      ctx.ui.notify(`That key didn't work: ${(e as Error).message}`, "error");
      return false;
    }
    saveKeySpec(key);
    spec = key;
    register();
    ctx.ui.notify(`Key saved to ${KEY_FILE}.`, "info");
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    for (const n of notes.splice(0)) ctx.ui.notify(n, "info");
    if (!resolveKey(spec) && (await askForKey(ctx))) {
      const note = setDefaultIfUnset();
      if (note) ctx.ui.notify(`${note} Restart pi to start on it.`, "info");
    }
  });

  pi.registerCommand("vechkabaz-key", {
    description: "Set or replace your ai.vechkabaz.com API key",
    handler: async (_args, ctx) => {
      await askForKey(ctx);
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the web. Returns titles, URLs and snippets.",
    promptSnippet: "Search the web for current information, docs and error messages",
    promptGuidelines: [
      "Use web_search for anything version-specific, recent, or that you are unsure of, and cite the URLs you relied on.",
      "Use web_fetch to read a result in full before quoting or relying on its details.",
    ],
    parameters: Type.Object({ query: Type.String({ description: "What to search for" }) }),
    async execute(_id, params, signal) {
      try {
        const r = await api(`/search?q=${encodeURIComponent(params.query)}`, resolveKey(spec), signal);
        const text = r.results.length
          ? r.results.map((h: any, i: number) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n\n")
          : `No results for "${params.query}".`;
        return { content: [{ type: "text", text }], details: { count: r.results.length } };
      } catch (e) {
        return { content: [{ type: "text", text: `web_search failed: ${(e as Error).message}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description: "Fetch a public web page or PDF and return its readable text.",
    parameters: Type.Object({ url: Type.String({ description: "http(s) URL to read" }) }),
    async execute(_id, params, signal) {
      try {
        const r = await api(`/fetch?url=${encodeURIComponent(params.url)}`, resolveKey(spec), signal);
        return { content: [{ type: "text", text: `${r.final_url}\n\n${r.text}` }], details: { url: r.final_url } };
      } catch (e) {
        return { content: [{ type: "text", text: `web_fetch failed: ${(e as Error).message}` }], details: {} };
      }
    },
  });
}
