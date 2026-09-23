/**
 * pi ↔ ai.vechkabaz.com: registers the models, adds web_search and web_fetch, and
 * migrates any hand-written provider entry for this server out of models.json
 * (models.json overrides extension providers, so a stale entry would win).
 */
import { execSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const VERSION = "0.5.2";
const BASE = (process.env.VECHKABAZ_URL ?? "https://ai.vechkabaz.com/api/v1").replace(/\/$/, "");
const HOST = new URL(BASE).host;
const PROVIDER = "vechkabaz";
const DEFAULT_MODEL = "coder-max";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const KEY_FILE = join(AGENT_DIR, "vechkabaz.json");
const HEADERS = { "User-Agent": `pi-vechkabaz/${VERSION}` };
// The server pins this id to the second GPU, so a subagent never evicts the parent's model.
const SUBAGENT_MODEL = `${PROVIDER}/coder-sub`;
// Only this parent model gets the subagent tool; everything else never sees it.
const ORCHESTRATOR_ID = "coder-max";
// Set on the child pi process only: the server doesn't list coder-sub, and it must
// never show up in a person's /model picker.
const IS_SUBAGENT = process.env.PI_VECHKABAZ_SUBAGENT === "1";
const SUBAGENT_TOOLS = "read,grep,find,ls,web_search,web_fetch";
// The child loads exactly this file, so it runs the parent's version even when the
// parent was started with -e (nothing installed) and picks up no other extensions.
const SELF = fileURLToPath(import.meta.url);
const SUBAGENT_TIMEOUT_MS = 10 * 60_000;
// The server allows 3 harness turns in flight per account and the parent's own turn
// is one of them, so 2 helpers is the most that fit beside an active conversation.
const MAX_SUBAGENTS = 2;
const SUBAGENT_PROMPT = `You are a read-only research subagent working for another agent.
Investigate the task with read, grep, find, ls, web_search and web_fetch. You cannot edit
files or run commands, and nobody will answer questions, so do not ask any.
Finish with a concise report: what you found, with file paths and line numbers or URLs,
and anything you could not confirm.`;

/** What each server model can do; ids the server lists but this table lacks get defaults. */
const PROFILES: Record<string, { name: string; image: boolean; ctx: number }> = {
  "coder-max": { name: "coder-max (careful, 27B)", image: true, ctx: 131072 },
  coder: { name: "coder (fast)", image: true, ctx: 262144 },
  "fable-711": { name: "fable-711 (peer machine)", image: false, ctx: 32768 },
  uncensored: { name: "uncensored", image: true, ctx: 131072 },
  "coder-sub": { name: "coder-sub (subagent, second GPU)", image: true, ctx: 131072 },
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

/** The one argument worth showing for a tool call: its path, pattern, query, URL or command. */
function argSummary(args: any): string {
  const v = args?.path ?? args?.file_path ?? args?.pattern ?? args?.query ?? args?.url ?? args?.command ?? "";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > 70 ? s.slice(0, 67) + "…" : s;
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
  if (IS_SUBAGENT) modelList.push(toModel("coder-sub"));

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

  const isOrchestrator = (m: { provider?: string; id?: string } | undefined) =>
    m?.provider === PROVIDER && m?.id === ORCHESTRATOR_ID;
  // Hidden, not refused: its guidelines leave the prompt too, and smaller models
  // stay under their tool budget.
  const syncSubagent = (m: { provider?: string; id?: string } | undefined) => {
    const active = pi.getActiveTools().filter((t) => t !== "subagent");
    pi.setActiveTools(isOrchestrator(m) ? [...active, "subagent"] : active);
  };
  pi.on("session_start", async (_e, ctx) => syncSubagent(ctx.model));
  pi.on("model_select", async (e) => syncSubagent(e.model));

  // Background helpers, each report injected when it finishes.
  const running = new Map<number, { kill: () => void; steps: number; started: number; task: string; trail: string[] }>();
  let nextId = 1;
  pi.on("session_shutdown", async () => {
    for (const r of running.values()) r.kill();
  });

  /** Runs the child pi to completion; resolves with its last assistant text. */
  const runChild = (task: string, cwd: string, onStep: (steps: number, tool: string, args: any) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vechkabaz-sub-"));
    const promptFile = join(dir, "subagent.md");
    writeFileSync(promptFile, SUBAGENT_PROMPT, { mode: 0o600 });
    const script = process.argv[1];
    const [cmd, pre] = script && existsSync(script) ? [process.execPath, [script]] : ["pi", []];
    const args = [...pre, "--no-extensions", "-e", SELF, "--mode", "json", "-p", "--no-session", "--model", SUBAGENT_MODEL,
      "--tools", SUBAGENT_TOOLS, "--append-system-prompt", promptFile, `Task: ${task}`];
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_VECHKABAZ_SUBAGENT: "1" } });
    const kill = () => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
    };
    const done = new Promise<{ report: string; steps: number; error?: string }>((resolve) => {
      let report = "";
      let steps = 0;
      let stderr = "";
      let buf = "";
      const timer = setTimeout(kill, SUBAGENT_TIMEOUT_MS);
      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          let e: any;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (e.type === "tool_execution_start") onStep(++steps, e.toolName, e.args);
          if (e.type === "message_end" && e.message?.role === "assistant") {
            const text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
            if (text.trim()) report = text;
          }
        }
      });
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      const finish = (code: number | null) => {
        clearTimeout(timer);
        rmSync(dir, { recursive: true, force: true });
        resolve(report ? { report, steps } : { report, steps, error: `exit ${code}: ${stderr.trim().slice(-400) || "no report"}` });
      };
      proc.on("close", finish);
      proc.on("error", () => finish(1));
    });
    return { done, kill };
  };

  /* ---------------------------------------------------------------- status line
   * Below the editor: the model's warm/cold state, the B60 helper's (on the
   * orchestrator), a context bar, and running subagents. */
  let warm: Set<string> | undefined;
  let barCtx: any;
  /** Observed cold-load seconds per model, from /api/v1/models. */
  const loadS = new Map<string, number>();
  /** A model call that has not produced output yet: drives the countdown. */
  let waiting: { since: number; cold: boolean; eta: number | null } | undefined;
  let responseStart = 0;
  const renderBar = (ctx?: any) => {
    if (ctx) barCtx = ctx;
    const c = barCtx;
    if (IS_SUBAGENT || !c?.hasUI) return;
    c.ui.setWidget(
      "vechkabaz",
      (_tui: unknown, theme: any) => {
        const parts: string[] = [];
        const m = c.model;
        const waitS = waiting ? Math.round((Date.now() - waiting.since) / 1000) : 0;
        if (m?.provider === PROVIDER && waiting && (waiting.cold || waitS >= 3)) {
          if (waiting.cold && waiting.eta) {
            const frac = Math.min(1, waitS / waiting.eta);
            const f = Math.round(frac * 8);
            const left = waiting.eta - waitS;
            parts.push(
              theme.fg("warning", `○ ${m.id} loading `) + theme.fg("warning", "▰".repeat(f)) + theme.fg("borderMuted", "▱".repeat(8 - f)) +
              theme.fg("dim", left > 0 ? ` ~${left}s left` : ` ${waitS}s, longer than usual`),
            );
          } else if (waiting.cold) {
            parts.push(theme.fg("warning", `○ ${m.id} loading `) + theme.fg("dim", `${waitS}s`));
          } else {
            parts.push(theme.fg("dim", `… waiting for the GPU · ${waitS}s`));
          }
        } else if (m?.provider === PROVIDER) {
          const w = warm?.has(m.id);
          parts.push(
            w === undefined ? theme.fg("dim", `◌ ${m.id}`)
            : w ? theme.fg("success", `● ${m.id} warm`)
            : theme.fg("warning", `○ ${m.id} cold (loads on next turn)`),
          );
          // A running helper is loaded by definition; the 30 s poll can lag behind it.
          if (isOrchestrator(m) && running.size) parts.push(theme.fg("accent", `◆ helper busy (${running.size})`));
          else if (isOrchestrator(m) && warm) {
            parts.push(warm.has("coder-sub") ? theme.fg("success", "● helper warm") : theme.fg("dim", "○ helper cold"));
          }
        }
        const u = c.getContextUsage?.();
        if (u?.percent != null && u.tokens != null) {
          const filled = Math.min(10, Math.round(u.percent / 10));
          const color = u.percent >= 85 ? "error" : u.percent >= 60 ? "warning" : "success";
          const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
          parts.push(`${theme.fg("muted", "ctx ")}${theme.fg(color, "▰".repeat(filled))}${theme.fg("borderMuted", "▱".repeat(10 - filled))} ${theme.fg(color, `${Math.round(u.percent)}%`)} ${theme.fg("dim", `${k(u.tokens)}/${k(u.contextWindow)}`)}`);
        }
        // Running helpers' trails sit above the status line, all below the input.
        const lines: string[] = [];
        for (const [n, r] of running) {
          const task = r.task.replace(/\s+/g, " ");
          lines.push(
            theme.fg("accent", `◆ subagent #${n}  `) +
              theme.fg("dim", `${task.length > 60 ? task.slice(0, 57) + "…" : task} · ${r.steps} steps · ${Math.round((Date.now() - r.started) / 1000)}s`),
          );
          r.trail.forEach((t, i) =>
            lines.push(theme.fg("dim", i === r.trail.length - 1 ? "  └ " : "  ├ ") + (i === r.trail.length - 1 ? theme.fg("accent", t) : theme.fg("muted", t))),
          );
        }
        lines.push(parts.join(theme.fg("borderMuted", "  │  ")));
        return new Text(lines.join("\n"), 0, 0);
      },
      { placement: "belowEditor" },
    );
  };
  const refreshWarm = async () => {
    try {
      const r = await api("/models", resolveKey(spec), AbortSignal.timeout(8_000));
      warm = Array.isArray(r.warm) ? new Set(r.warm) : undefined;
      for (const m of r.data ?? []) if (typeof m.load_s === "number") loadS.set(m.id, m.load_s);
    } catch {
      warm = undefined;
    }
    renderBar();
  };
  if (!IS_SUBAGENT) {
    pi.on("session_start", async (_e, ctx) => {
      renderBar(ctx);
      void refreshWarm();
    });
    pi.on("model_select", async (_e, ctx) => renderBar(ctx));
    pi.on("agent_start", async () => {
      responseStart = Date.now();
    });
    pi.on("turn_start", async (_e, ctx) => {
      const id = ctx.model?.provider === PROVIDER ? ctx.model.id : undefined;
      waiting = id ? { since: Date.now(), cold: warm ? !warm.has(id) : false, eta: loadS.get(id) ?? null } : undefined;
      renderBar(ctx);
    });
    pi.on("message_update", async (_e, ctx) => {
      if (!waiting) return;
      waiting = undefined;
      renderBar(ctx);
    });
    pi.on("turn_end", async (_e, ctx) => {
      waiting = undefined;
      renderBar(ctx);
    });
    pi.on("agent_end", async (_e, ctx) => {
      waiting = undefined;
      renderBar(ctx);
      void refreshWarm();
      void receipt(ctx);
    });
    setInterval(() => void refreshWarm(), 30_000).unref();
    // Keeps elapsed seconds moving while helpers run or a call waits.
    setInterval(() => (running.size || waiting) && renderBar(), 1_000).unref();
  }

  /* ------------------------------------------------------------ turn receipt
   * One dim line after each response, summing its model calls. appendEntry keeps
   * it out of the model's context. */
  const receipt = async (ctx: any) => {
    const m = ctx.model;
    if (m?.provider !== PROVIDER || !responseStart) return;
    try {
      const r = await api(`/turns?since=${responseStart - 1000}&model=${encodeURIComponent(m.id)}`, resolveKey(spec), AbortSignal.timeout(8_000));
      const turns: any[] = r.turns ?? [];
      if (!turns.length) return;
      const sum = (k: string) => turns.reduce((n, t) => n + (typeof t[k] === "number" ? t[k] : 0), 0);
      const decodeMs = turns.reduce((n, t) => n + (t.tps && t.predictedN ? (t.predictedN / t.tps) * 1000 : 0), 0);
      const devices = [...new Set(turns.map((t) => (t.device ?? "peer").toUpperCase()))];
      pi.appendEntry("vechkabaz-receipt", {
        calls: turns.length,
        fresh: sum("promptN"),
        cached: Math.max(0, ...turns.map((t) => t.cacheN ?? 0)),
        prefillS: sum("promptMs") / 1000,
        wrote: sum("predictedN"),
        tps: decodeMs ? sum("predictedN") / (decodeMs / 1000) : null,
        loadS: sum("loadMs") / 1000,
        queuedS: sum("queuedMs") / 1000,
        wh: turns.some((t) => typeof t.wh === "number") ? sum("wh") : null,
        where: `${m.id} on ${devices.join("+")}`,
      });
    } catch {
      // A missing receipt is not worth an error line.
    }
  };
  pi.registerEntryRenderer("vechkabaz-receipt", (entry: any, _opts: any, theme: any) => {
    const d = entry.data ?? {};
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
    const bits = [
      d.calls > 1 ? `${d.calls} calls` : null,
      `read ${k(d.fresh)} fresh (${k(d.cached)} cached) in ${d.prefillS.toFixed(1)}s`,
      d.tps ? `wrote ${k(d.wrote)} at ${d.tps.toFixed(1)} t/s` : `wrote ${k(d.wrote)}`,
      d.loadS >= 1 ? `loaded ${Math.round(d.loadS)}s` : null,
      d.queuedS >= 1 ? `queued ${Math.round(d.queuedS)}s` : null,
      d.where,
      typeof d.wh === "number" ? `${d.wh.toFixed(2)} Wh` : null,
    ].filter(Boolean);
    return new Text(theme.fg("dim", `↳ ${bits.join(" · ")}`), 1, 0);
  });

  /* ------------------------------------------------------------ subagent report */
  pi.registerMessageRenderer("subagent-report", (message: any, { expanded, outputPad }: any, theme: any) => {
    const d = (message.details ?? {}) as { id?: number; steps?: number; secs?: number; ok?: boolean; task?: string; report?: string };
    const head =
      theme.fg(d.ok ? "success" : "error", d.ok ? "✔ " : "✘ ") +
      theme.bold(theme.fg("accent", `Subagent #${d.id}`)) +
      theme.fg("dim", `  ·  ${d.steps ?? 0} steps  ·  ${d.secs ?? 0}s`);
    const task = theme.fg("muted", `Task: ${(d.task ?? "").replace(/\s+/g, " ").slice(0, expanded ? 2000 : 140)}`);
    const body = String(d.report ?? message.content ?? "");
    const lines = body.split("\n");
    const shown = expanded || lines.length <= 8 ? body : lines.slice(0, 8).join("\n");
    const box = new Box(outputPad, 1, (t: string) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${head}\n${task}`, 0, 0));
    box.addChild(new Markdown(shown, 0, 1, getMarkdownTheme()));
    if (!expanded && lines.length > 8) {
      box.addChild(new Text(theme.fg("dim", `… ${lines.length - 8} more lines (ctrl+o to expand)`), 0, 0));
    }
    return box;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Start a read-only helper on a self-contained research task. Returns immediately; the helper's report arrives later as a message in this conversation.",
    promptSnippet: "Delegate broad read-only investigation in the background; its report arrives later",
    promptGuidelines: [
      "Use subagent for investigation that would take many file reads or searches (mapping an unfamiliar codebase, finding every usage of something, researching a library), so those contents stay out of your context. Give it a complete, self-contained task.",
      "subagent runs in the background: after starting it, tell the user and carry on with other work. Do not wait or poll for it; its report arrives on its own as a message. Up to 2 can run at once, so split independent questions across two calls.",
      "subagent cannot edit files or run commands; do the changes yourself from its report.",
    ],
    parameters: Type.Object({ task: Type.String({ description: "Complete instructions for the helper, including what to report back" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!isOrchestrator(ctx.model)) {
        return { content: [{ type: "text", text: `subagent is only available on ${PROVIDER}/${ORCHESTRATOR_ID}.` }], details: {} };
      }
      if (running.size >= MAX_SUBAGENTS) {
        return {
          content: [{ type: "text", text: `${MAX_SUBAGENTS} subagents are already running (#${[...running.keys()].join(", #")}); start another once one reports back.` }],
          details: {},
        };
      }
      const id = nextId++;
      const started = Date.now();
      const status = () => renderBar(ctx);
      const child = runChild(params.task, ctx.cwd, (steps, tool, args) => {
        const r = running.get(id);
        if (r) {
          r.steps = steps;
          r.trail = [...r.trail, `${tool.padEnd(11)}${argSummary(args)}`].slice(-4);
        }
        status();
      });
      running.set(id, { kill: child.kill, steps: 0, started, task: params.task, trail: [] });
      status();
      void child.done.then(({ report, steps, error }) => {
        running.delete(id);
        status();
        void refreshWarm();
        const secs = Math.round((Date.now() - started) / 1000);
        pi.sendMessage(
          {
            customType: "subagent-report",
            content: error
              ? `Subagent #${id} failed after ${secs}s (${error}).\nTask: ${params.task}`
              : `Subagent #${id} report (${steps} steps, ${secs}s).\nTask: ${params.task}\n\n${report}`,
            display: true,
            details: { id, steps, secs, ok: !error, task: params.task, report: error ?? report },
          },
          // After the current turn's tool calls, never mid-turn; answers at once if idle.
          { deliverAs: "followUp", triggerTurn: true },
        );
      });
      return {
        content: [{ type: "text", text: `Started subagent #${id} in the background. Its report will arrive as a message when it finishes; continue meanwhile.` }],
        details: { id },
      };
    },
  });

  pi.registerCommand("subagent-stop", {
    description: "Stop running subagents (all, or one by number: /subagent-stop 2)",
    handler: async (args, ctx) => {
      if (!running.size) return ctx.ui.notify("No subagent is running.", "info");
      const want = Number(String(args ?? "").trim().replace(/^#/, "")) || undefined;
      const ids = want ? [want].filter((n) => running.has(n)) : [...running.keys()];
      if (!ids.length) return ctx.ui.notify(`No running subagent #${want}.`, "warning");
      for (const n of ids) running.get(n)!.kill();
      ctx.ui.notify(`Stopping subagent #${ids.join(", #")}.`, "info");
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
