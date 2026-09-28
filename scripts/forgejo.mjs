// Shared core for the Forgejo Issues plugin: config, token, repo discovery,
// the Forgejo API client, and the formatting helpers both the hook and the
// MCP server use.
//
// House rules, in order:
// 1. Hooks never block and never hide a failure: every operational problem
//    resolves into an actionable message (reported once per session) or into
//    silence when silence IS the correct behavior.
// 2. The token is never written anywhere and never appears in an error.
// 3. Never query with an unverified label name. Measured on Forgejo
//    16.0.5+gitea-1.22.0: a labels= filter naming an unknown label is not an
//    error -- the name is silently dropped and the query returns ALL issues.
//    Resolve the label to an id first, or do not query at all.
// 4. Scope stays TODO-focused; see NOTES.md for what that rules out.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "./request.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Config and token share a directory OUTSIDE any repo: nothing this plugin
// reads or writes (except per-session state) ever lands in the user's tree.
// XDG_CONFIG_HOME doubles as the offline-test seam.
export const configDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "claude-forgejo-issues"
);

export function tokenPath() {
  return join(configDir, "token");
}

// Per-session state and the optional error log live here. CLAUDE_PLUGIN_DATA
// is the plugin-scoped directory Claude Code provides; tmpdir is the fallback
// for running the scripts bare.
export const dataDir =
  process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "claude-forgejo-issues");

// ---------------------------------------------------------------------------
// Config: plugin settings > config.json > defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  host: "git.danya02.ru",
  markerLabel: "agent-todo",
  injectOnPrompt: false,
  attribution: true,
  attributionSession: true,
  timeoutSeconds: 5,
  debugLog: false,
};

// The per-machine config file sits next to the token. A missing or invalid
// file falls back to defaults silently: config.json is optional by design,
// and a broken optional file must not turn every session into an error
// report. Wrong-typed values are ignored the same way.
function readConfigFile() {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Claude Code substitutes ${user_config.<key>} into .mcp.json env values;
// when an option was never configured, what arrives can be the literal
// placeholder text, which counts as unset. Whole-value match: a real value
// that merely contains that substring is never discarded. What an unset
// option substitutes to is undocumented, so all three shapes (empty string,
// absent variable, literal placeholder) must fall through.
function envString(key) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  return /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(value) ? null : value;
}

// "true"/"1" and "false"/"0" are accepted; anything else counts as unset so
// a typo can only fall back to the default, never flip behavior.
function envBool(key) {
  const raw = envString(key);
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

function envNumber(key) {
  const raw = envString(key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickString(source, fallback) {
  return typeof source === "string" && source.trim() !== "" ? source.trim() : fallback;
}

function pickBool(source, fallback) {
  return typeof source === "boolean" ? source : fallback;
}

function pickNumber(source, fallback, min, max) {
  return Number.isFinite(source) ? Math.min(max, Math.max(min, source)) : fallback;
}

// Exported for tests. Resolution order: plugin settings (userConfig arrives
// as CLAUDE_PLUGIN_OPTION_* env) > config.json > defaults.
export const config = {
  host: pickString(envString("forge_host") ?? readConfigFile().forge_host, DEFAULTS.host),
  markerLabel: pickString(envString("marker_label") ?? readConfigFile().marker_label, DEFAULTS.markerLabel),
  injectOnPrompt: pickBool(envBool("inject_on_prompt") ?? readConfigFile().inject_on_prompt, DEFAULTS.injectOnPrompt),
  attribution: pickBool(envBool("attribution") ?? readConfigFile().attribution, DEFAULTS.attribution),
  attributionSession: pickBool(envBool("attribution_session") ?? readConfigFile().attribution_session, DEFAULTS.attributionSession),
  // userConfig exposes seconds (1-30); the client wants ms.
  timeoutMs:
    pickNumber(
      envNumber("request_timeout_seconds") ?? readConfigFile().request_timeout_seconds,
      DEFAULTS.timeoutSeconds,
      1,
      30
    ) * 1000,
  debugLog: pickBool(envBool("debug_log") ?? readConfigFile().debug_log, DEFAULTS.debugLog),
};

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

// Plugin option first (the /plugin dialog, stored in the OS secure store),
// then the env var (handy for one-off runs and CI), then the token file. A
// missing token is not an error here -- the hook reports it once, MCP tools
// answer with a clean error, and nothing crashes.
export function readToken() {
  const option = envString("forgejo_token");
  if (option) return option;
  const env = process.env.CLAUDE_FORGEJO_ISSUES_TOKEN;
  const fromEnv = env && env.trim() !== "" ? env.trim() : null;
  if (fromEnv) return fromEnv;
  try {
    const fromFile = readFileSync(tokenPath(), "utf8").trim();
    return fromFile !== "" ? fromFile : null;
  } catch {
    return null;
  }
}

// The one message both consumers (hook, MCP tools) show when no token is
// found. Names every storage choice and the token-creation URL on the
// configured host, so a fresh install can act on it without the README.
export function missingTokenMessage() {
  return (
    `No Forgejo API token found. Set "Forgejo API token" in the plugin's options ` +
    `(/plugin, Enter on Forgejo Issues, Configure options), or put a token with ` +
    `issue scope at ${tokenPath()}, or set CLAUDE_FORGEJO_ISSUES_TOKEN. ` +
    `Create an issue-scoped token at https://${config.host}/user/settings/applications.`
  );
}

// ---------------------------------------------------------------------------
// Repo discovery (the gate)
// ---------------------------------------------------------------------------

// `git remote -v` lines: "origin\tgit@github.com:o/r.git (fetch)".
export function parseRemotes(text) {
  const remotes = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    if (!m || m[3] !== "fetch") continue;
    remotes.push({ name: m[1], url: m[2] });
  }
  return remotes;
}

// Accepts https://, ssh://, git:// URLs and scp-like git@host:path strings;
// returns the lowercased hostname or null. Port is deliberately ignored: the
// gate is on instance, not port, so a forge on :8443 still matches.
export function hostOf(url) {
  const s = String(url).trim();
  if (s === "") return null;
  if (s.includes("://")) {
    try {
      return new URL(s).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
  const scp = s.match(/^[^/@]+@([^/:]+):/);
  return scp ? scp[1].toLowerCase() : null;
}

// "owner/repo" from a remote URL, or null. The .git suffix is stripped;
// Forgejo has no subgroups, so the first two path segments are owner and
// repo. Case is preserved -- the API path is case-sensitive.
export function repoPathOf(url) {
  const s = String(url).trim();
  let path = null;
  if (s.includes("://")) {
    try {
      path = new URL(s).pathname;
    } catch {
      return null;
    }
  } else {
    const scp = s.match(/^[^/@]+@[^/:]+:(.+)$/);
    if (scp) path = scp[1];
  }
  if (!path) return null;
  const segs = path.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segs.length < 2) return null;
  return `${segs[0]}/${segs[1]}`;
}

// Matches remotes against the forge host. origin wins when it matches (the
// conventional primary); otherwise alphabetical order keeps behavior stable
// with any number of extra remotes. Candidates whose owner/repo cannot be
// extracted are skipped -- they cannot be queried anyway.
export function findForgeRemote(text, host) {
  const wanted = String(host).toLowerCase();
  const matches = parseRemotes(text).filter((r) => hostOf(r.url) === wanted);
  matches.sort((a, b) => {
    const ao = a.name === "origin" ? 0 : 1;
    const bo = b.name === "origin" ? 0 : 1;
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
  });
  for (const r of matches) {
    const path = repoPathOf(r.url);
    if (path) {
      const [owner, repo] = path.split("/");
      return { name: r.name, url: r.url, owner, repo };
    }
  }
  return null;
}

// Runs `git remote -v` in cwd and matches against the configured forge host.
// Any failure -- no git binary, not a repo, timeout -- means "not a forge
// repo": null, and both consumers go dormant. This is the plugin's gate.
export function resolveTarget(cwd = process.cwd()) {
  let text;
  try {
    text = execFileSync("git", ["-C", String(cwd ?? "."), "remote", "-v"], {
      timeout: 3000,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  return findForgeRemote(text, config.host);
}

// ---------------------------------------------------------------------------
// Forgejo client
// ---------------------------------------------------------------------------

// All API calls go through call(): it never throws. Transport failures and
// HTTP error statuses come back as { error } strings that carry method, URL
// (the token rides in a header, never the URL) and the route the request
// took; parse failures carry a body hint. status and data accompany errors
// so callers can special-case 404 and friends.
export function forgeClient(target, token) {
  // Test seam: the offline tests stand in a local server for the forge.
  const base =
    process.env.CLAUDE_FORGEJO_ISSUES_BASE_URL ||
    `https://${config.host}/api/v1/repos/${target.owner}/${target.repo}`;

  async function call(method, path, bodyObj = null) {
    const url = `${base}${path}`;
    try {
      const res = await request(method, url, {
        headers: {
          authorization: `token ${token}`,
          "content-type": "application/json",
        },
        body: bodyObj === null ? null : JSON.stringify(bodyObj),
        timeoutMs: config.timeoutMs,
      });
      if (res.status >= 400) {
        return { status: res.status, data: null, error: `${method} ${url}: HTTP ${res.status}${bodyHint(res.body)}` };
      }
      let data = null;
      if (res.body !== "") {
        try {
          data = JSON.parse(res.body);
        } catch {
          return { status: res.status, data: null, error: `${method} ${url}: HTTP ${res.status} returned a non-JSON body` };
        }
      }
      return { status: res.status, data, error: null };
    } catch (err) {
      return { status: 0, data: null, error: `${method} ${url}: ${err.message}` };
    }
  }

  return { call };
}

// Forgejo error bodies are JSON like {"message": "..."}; surface a trimmed
// message so "HTTP 422" becomes actionable. Falls back to the raw body.
function bodyHint(body) {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") {
      return ` -- ${parsed.message.slice(0, 200)}`.replace(/\s+/g, " ");
    }
  } catch {
    // not JSON: fall through to the raw-body hint
  }
  const trimmed = body.trim().slice(0, 120).replace(/\s+/g, " ");
  return trimmed !== "" ? ` -- ${trimmed}` : "";
}

// ---------------------------------------------------------------------------
// Labels and issues
// ---------------------------------------------------------------------------

export const PAGE_SIZE = 50; // measured: the API's own maximum page size
export const MAX_PAGES = 10; // caps a full sweep at 500 issues -- a TODO
                              // store that big is pathological, and hooks
                              // must stay latency-bounded

// Pages GET path (which must already carry its query string) until a short
// page or the cap. Never throws; a page failure short-circuits with the
// accumulated items plus the error.
export async function paginate(client, path, cap = MAX_PAGES) {
  const items = [];
  for (let page = 1; page <= cap; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await client.call("GET", `${path}${sep}page=${page}&limit=${PAGE_SIZE}`);
    if (res.error) return { items, error: res.error };
    const batch = Array.isArray(res.data) ? res.data : [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return { items };
  }
  return { items }; // cap reached: 500 items, count shown honestly
}

// Resolves the marker label to its numeric id by paging /labels. Absent ->
// { id: null }, which means "zero TODOs" -- never an error, and never a
// filtered query with a name (see the header rules). Match is exact after
// lowercasing; every later query uses the id, so server-side case rules stay
// irrelevant.
export async function resolveLabel(client, name) {
  let page = 1;
  while (page <= MAX_PAGES) {
    const res = await client.call("GET", `/labels?limit=${PAGE_SIZE}&page=${page}`);
    if (res.error) return { error: `Looking up the "${name}" label: ${res.error}` };
    const labels = Array.isArray(res.data) ? res.data : [];
    for (const label of labels) {
      if (String(label.name ?? "").toLowerCase() === name.toLowerCase()) {
        return { id: label.id };
      }
    }
    if (labels.length < PAGE_SIZE) return { id: null };
    page += 1;
  }
  return { id: null }; // >500 labels: reported as zero TODOs (see NOTES.md)
}

// State-filtered issues, optionally narrowed to a label id. Callers MUST
// pass a labelId obtained from resolveLabel when filtering -- name-based
// filtering is unsafe (header rules).
export async function listIssues(client, { state = "open", labelId = null } = {}) {
  const stateParam = state === "all" ? "all" : state;
  const labelParam = labelId === null ? "" : `&labels=${encodeURIComponent(String(labelId))}`;
  return await paginate(client, `/issues?state=${encodeURIComponent(stateParam)}&type=issues${labelParam}`);
}

// Creates the marker label. Best-effort by design: two sessions racing to
// create it is fine (422 just means the other one won), and a real failure
// surfaces to the caller as the API error it is.
export async function createMarkerLabel(client, name) {
  return await client.call("POST", "/labels", {
    name,
    color: "#7c3aed",
    description: "Agent TODO store (claude-forgejo-issues)",
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// CLAUDE_CODE_SESSION_ID is a UUID inherited by plugin processes (verified
// against live plugin MCP servers). Validated before use so a future change
// of shape can only drop the session reference, never inject odd text into
// the forge.
export function sessionRef() {
  const id = process.env.CLAUDE_CODE_SESSION_ID || "";
  return /^[0-9a-f-]{16,64}$/i.test(id) ? id : null;
}

// The attribution footer appended to issues, body edits and comments the
// tools create, so agent-authored content is distinguishable from the user's
// own -- both come from the same account. Both parts toggle independently.
export function attribution() {
  if (!config.attribution) return "";
  const session = sessionRef();
  const sessionPart =
    config.attributionSession && session ? ` -- session \`${session}\`` : "";
  return `\n\n---\n<sub>Written by Claude with [claude-forgejo-issues](https://github.com/danya02/claude-forgejo-issues)${sessionPart}</sub>`;
}

// Removes trailing attribution footers (any number: bodies edited before this
// existed can carry several). edit_issue strips before re-appending, so a body
// read with get_issue and passed back does not grow a second footer; get_issue
// strips for display, since the footer is noise to the reader.
const FOOTER_RE = /(?:\s*\n---\n<sub>Written by Claude with \[claude-forgejo-issues\]\([^)\n]*\)[^\n]*<\/sub>)+\s*$/;

export function stripAttribution(text) {
  const s = String(text ?? "");
  const stripped = s.replace(FOOTER_RE, "");
  return { text: stripped, attributed: stripped !== s };
}

// One issue, one line: "#12 title [agent-todo, bug]". All labels are shown:
// in the filtered view the marker label is among them, and in the widened
// view the extra labels are information.
export function describeIssue(issue) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l) => String(l.name ?? "")).filter(Boolean)
    : [];
  const tag = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
  return `#${issue.number} ${String(issue.title ?? "")}${tag}`;
}

// The injected/returned list. countLabel tracks the filter: "open" by
// default, "closed"/"listed" for the other states.
export function renderList(target, issues, countLabel = "open") {
  const where = `${config.host}/${target.owner}/${target.repo}`;
  if (issues.length === 0) return `Forgejo TODOs on ${where} -- none ${countLabel}.`;
  return `Forgejo TODOs on ${where} -- ${issues.length} ${countLabel}:\n${issues.map(describeIssue).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Per-session state and error reporting
// ---------------------------------------------------------------------------

// State files are keyed by ids taken from hook input; anything not shaped
// like an id must never reach a filesystem path. Throws on garbage.
export function safeId(id) {
  const s = String(id ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) {
    throw new Error(`internal: refusing to use ${JSON.stringify(s.slice(0, 24))} as a file name`);
  }
  return s;
}

// tmp + rename in the same directory; plain-write fallback for filesystems
// where rename over an existing file is restricted. A doubly-lost state
// write only costs one redundant full injection, so it is swallowed.
export function writeAtomic(file, content) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch {
    try {
      writeFileSync(file, content);
    } catch {
      // both failed: next read just misses state, behavior stays correct
    }
  }
}

// Last injected list hash + count, and the last reported error (a distinct
// error reports once per session; a repeat stays silent).
export function readSessionState(id) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dataDir, "sessions", `${safeId(id)}.json`), "utf8")
    );
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSessionState(id, state) {
  writeAtomic(join(dataDir, "sessions", `${safeId(id)}.json`), JSON.stringify(state));
}

// Optional ndjson error log (debug_log). Logging must never crash a hook:
// every step is guarded. The token can never reach it because it never
// enters an error string.
export function logError(where, err) {
  if (!config.debugLog) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(
      join(dataDir, "errors.ndjson"),
      `${JSON.stringify({ ts: new Date().toISOString(), where, message: String(err?.message ?? err) })}\n`
    );
  } catch {
    // logging must never be the thing that fails
  }
}
