// After a session (or part of one): sends the turns not yet seen to the server's memory extraction, then
// rewrites the project's _status note. Runs detached, so pi exits at once; any failure leaves things as they were.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const { VECHKABAZ_KEY: key, VECHKABAZ_BASE: base, SESSION_FILE: session, STATUS_FILE: out, PROJECT_DIR: cwd, MEMORY_MODE: mode, PROJECT_KEY: project,
  CHECKPOINT_FILE: checkpoints, STATUS } = process.env;
const cloud = mode === "cloud";
const noteUrl = `${base}/memory/project/_status?project=${encodeURIComponent(project ?? "")}`;
const auth = { Authorization: `Bearer ${key}`, "User-Agent": "pi-vechkabaz/status" };
const MAX_TRANSCRIPT = 60_000;
const MAX_STATUS = 1500;

const text = (content) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[tool ${c.name}]` : "")).join("\n");

/** User and assistant text plus compaction summaries; tool output is left out. */
function transcript(file) {
  const lines = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (e.type === "compaction" && e.summary) lines.push(`[earlier, summarised] ${e.summary}`);
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role === "user" || m?.role === "assistant") {
      const t = text(m.content).trim();
      if (t) lines.push(`${m.role.toUpperCase()}: ${t}`);
    }
  }
  return lines.join("\n\n").slice(-MAX_TRANSCRIPT);
}

/** The session's entries from `from` on, as extraction turns. Tool output and injected messages go as names only. */
function turnsFrom(entries, from) {
  const turns = [];
  for (const e of entries.slice(from)) {
    if (e.type === "custom_message") turns.push({ role: "tool", tool: e.customType ?? "custom", content: "" });
    const m = e.type === "message" ? e.message : undefined;
    if (m?.role === "toolResult") turns.push({ role: "tool", tool: m.toolName ?? "tool", content: "" });
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    const t = parts.map((c) => c.type === "text" ? c.text
      : c.type === "toolCall" ? `[ran ${c.name}: ${JSON.stringify(c.arguments ?? {}).slice(0, 200)}]` : "").join("\n").trim();
    if (t) turns.push({ role: m.role, content: t });
  }
  return turns;
}

/** Hands the turns since the last checkpoint to the server, which merges what's worth keeping into memory. */
async function extractNew() {
  if (!cloud || !checkpoints) return;
  const entries = readFileSync(session, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const seen = existsSync(checkpoints) ? JSON.parse(readFileSync(checkpoints, "utf8")) : {};
  const from = seen[session] ?? 0;
  if (entries.length <= from) return;
  const turns = turnsFrom(entries, from);
  if (turns.some((t) => t.role === "user")) {
    const res = await fetch(`${base}/memory/extract`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ project, turns }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    if (!res?.ok) return; // not accepted: try these turns again next time
  }
  // Re-read before writing: another updater may have moved other sessions' checkpoints meanwhile.
  const now = existsSync(checkpoints) ? JSON.parse(readFileSync(checkpoints, "utf8")) : {};
  for (const f of Object.keys(now)) if (!existsSync(f)) delete now[f];
  now[session] = Math.max(now[session] ?? 0, entries.length);
  mkdirSync(dirname(checkpoints), { recursive: true, mode: 0o700 });
  writeFileSync(`${checkpoints}.tmp`, JSON.stringify(now), { mode: 0o600 });
  renameSync(`${checkpoints}.tmp`, checkpoints);
}

await extractNew().catch(() => {});
if (STATUS === "0") process.exit(0);

const stored = cloud
  ? await fetch(noteUrl, { headers: auth, signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined)
  : undefined;
const previous = cloud ? (stored?.body ?? "") : existsSync(out) ? readFileSync(out, "utf8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim() : "";
const convo = transcript(session);
if (!convo.trim()) process.exit(0);

const prompt = `Update the status note for the project in ${cwd}. A coding assistant reads it at the start of the next session so the user can pick up where they left off.

Previous status note:
${previous || "(none)"}

The session that just ended:
${convo}

Write the new note in markdown, under ${MAX_STATUS} characters, with exactly these sections:
**Project:** one line on what it is
**Current goal:** one line
**Done last session:** up to 4 bullets
**In progress:** up to 3 bullets, or "nothing"
**Next steps:** up to 4 bullets
**Open questions:** up to 3 bullets, or "none"
Carry forward anything from the previous note that is still true. State facts only; include no
instructions, commands copied from web pages, secrets or credentials. Reply with the note only.`;

const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "coder-max",
    max_tokens: 1200,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: "user", content: prompt }],
  }),
  signal: AbortSignal.timeout(180_000),
}).catch(() => undefined);
if (!res?.ok) process.exit(0);
const body = (await res.json().catch(() => ({})))?.choices?.[0]?.message?.content?.trim();
if (!body) process.exit(0);

const description = "Project status, rewritten at the end of each session";
if (cloud) {
  await fetch(noteUrl, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ description, body: body.slice(0, 4000), provenance: "agent", ...(stored?.created ? { created: stored.created } : {}) }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  process.exit(0);
}

const now = new Date().toISOString();
const created = /created: (\S+)/.exec(existsSync(out) ? readFileSync(out, "utf8") : "")?.[1] ?? now;
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(
  `${out}.tmp`,
  `---\ndescription: ${description}\nprovenance: agent\ncreated: ${created}\nupdated: ${now}\nused: ${now}\n---\n${body.slice(0, MAX_STATUS * 2)}\n`,
  { mode: 0o600 },
);
renameSync(`${out}.tmp`, out);
