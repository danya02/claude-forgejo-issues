#!/usr/bin/env node
// Offline test suite: no forge, no network, none of the real machine's
// configuration. A local HTTP server stands in for the forge, a fake `git`
// stands in for real remotes, and the hook and the MCP server run as real
// subprocesses exactly as Claude Code runs them.
//
// The environment is pinned BEFORE any plugin module is imported, so nothing
// here can touch ~/.config/claude-forgejo-issues or the real token.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const root = mkdtempSync(join(tmpdir(), "forgejo-issues-test-"));
const configHome = join(root, "config"); // XDG_CONFIG_HOME: isolates token + config.json
const pluginConfigDir = join(configHome, "claude-forgejo-issues");
const emptyConfigHome = join(root, "empty-config"); // a config dir with no token in it
const dataHome = join(root, "data"); // CLAUDE_PLUGIN_DATA: per-session state
const binDir = join(root, "bin"); // fake `git`, prepended to PATH
mkdirSync(pluginConfigDir, { recursive: true });
mkdirSync(join(emptyConfigHome, "claude-forgejo-issues"), { recursive: true });
mkdirSync(binDir);

// Proxy variables are scrubbed so the direct-transport tests are
// deterministic on any developer machine; proxyFor is unit-tested with
// explicit env objects instead of ambient ones.
for (const key of ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
  delete process.env[key];
}
process.env.XDG_CONFIG_HOME = configHome;
process.env.CLAUDE_PLUGIN_DATA = dataHome;
process.env.CLAUDE_FORGEJO_ISSUES_TOKEN = "test-token-123";
// A valid-shaped session id: attribution must pick it up in tool writes.
process.env.CLAUDE_CODE_SESSION_ID = "0123abcd-4567-48ba-9cde-f01234567890";

// Fake `git`: answers `git remote -v` (any arguments) with canned output, so
// the gate is exercised without a real repository or a real git binary.
writeFileSync(
  join(binDir, "git"),
  ["#!/bin/sh", "# test shim: canned `git remote -v` output", 'printf "%s\\n" "$FAKE_GIT_REMOTE"', "exit 0", ""].join("\n")
);
chmodSync(join(binDir, "git"), 0o755);

const SCRIPTS = new URL("../scripts/", import.meta.url);
const HOOK = new URL("hook.mjs", SCRIPTS).pathname;
const MCP = new URL("mcp.mjs", SCRIPTS).pathname;

// Plugin modules import only after the env is pinned.
const forgejo = await import(new URL("forgejo.mjs", SCRIPTS).href);
const requestMod = await import(new URL("request.mjs", SCRIPTS).href);

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(err?.stack ?? err).split("\n").join("\n      ")}`);
  }
}

function eq(actual, expected, label = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function ok(condition, label = "expected truthy") {
  if (!condition) throw new Error(label);
}

function includes(haystack, needle, label = "text") {
  if (!String(haystack ?? "").includes(needle)) {
    throw new Error(
      `${label}: ${JSON.stringify(needle)} not found in ${JSON.stringify(String(haystack ?? "").slice(0, 300))}`
    );
  }
}

let bust = 0;
// Re-imports a plugin module with a cache-busting query so import-time state
// (config, dataDir) re-resolves under the current environment.
function freshImport(script) {
  bust += 1;
  return import(`${new URL(script, SCRIPTS).href}?bust=${bust}`);
}

// ---------------------------------------------------------------------------
// Stand-in forge: scripted routes plus a full request log
// ---------------------------------------------------------------------------

const LABEL = { id: 2, name: "agent-todo", color: "#7c3aed", description: "Agent TODO store (claude-forgejo-issues)" };
const ISSUE_A = { number: 4, title: "Fix CI on main", state: "open", labels: [LABEL], html_url: "https://git.danya02.ru/danya/ci-demo/issues/4" };
const ISSUE_B = { number: 7, title: "Add caching", state: "open", labels: [LABEL], html_url: "https://git.danya02.ru/danya/ci-demo/issues/7" };
const ISSUE_C = { number: 9, title: "Write the docs", state: "open", labels: [LABEL], html_url: "https://git.danya02.ru/danya/ci-demo/issues/9" };

let routes = [];
let requests = []; // "METHOD /path?query", in arrival order

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push(`${req.method} ${req.url}`);
    const route = routes.find((r) => r.method === req.method && r.re.test(req.url));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `test forge: no route for ${req.method} ${req.url}` }));
      return;
    }
    const out = route.handler(body, req.url);
    if (out?.hang) return; // never respond: exercises the client timeout
    res.writeHead(out?.status ?? 200, { "content-type": "application/json" });
    res.end(out?.body === undefined ? "" : JSON.stringify(out.body));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const FORGE = `${origin}/api/v1/repos/danya/ci-demo`;
process.env.CLAUDE_FORGEJO_ISSUES_BASE_URL = FORGE;

function defaultRoutes() {
  return [
    { method: "GET", re: /\/labels\?/, handler: () => ({ body: [LABEL] }) },
    { method: "GET", re: /\/issues\?/, handler: () => ({ body: [ISSUE_A, ISSUE_B] }) },
  ];
}

// ---------------------------------------------------------------------------
// Unit: remote parsing (the gate's input)
// ---------------------------------------------------------------------------

await test("parseRemotes keeps fetch lines only", () => {
  eq(forgejo.parseRemotes("origin\tgit@github.com:o/r.git (fetch)\norigin\tgit@github.com:o/r.git (push)\nup\tx (fetch)\ngarbage line\n"), [
    { name: "origin", url: "git@github.com:o/r.git" },
    { name: "up", url: "x" },
  ]);
});

await test("hostOf accepts URL and scp-like forms, ignores ports, rejects junk", () => {
  eq(forgejo.hostOf("https://Git.Example.com/o/r"), "git.example.com");
  eq(forgejo.hostOf("ssh://git@git.danya02.ru:2222/danya/ci-demo.git"), "git.danya02.ru");
  eq(forgejo.hostOf("git@GIT.danya02.ru:danya/ci-demo.git"), "git.danya02.ru");
  eq(forgejo.hostOf("/srv/git/repo"), null);
  eq(forgejo.hostOf(""), null);
});

await test("repoPathOf strips .git and reads owner/repo", () => {
  eq(forgejo.repoPathOf("https://git.danya02.ru/danya/ci-demo.git"), "danya/ci-demo");
  eq(forgejo.repoPathOf("git@git.danya02.ru:danya/ci-demo"), "danya/ci-demo");
  eq(forgejo.repoPathOf("ssh://git@git.danya02.ru:2222/owner/repo.git"), "owner/repo");
  eq(forgejo.repoPathOf("https://git.danya02.ru/only"), null);
  eq(forgejo.repoPathOf("/srv/git/repo"), null);
});

await test("findForgeRemote filters by host, prefers origin, then alphabetical", () => {
  const text = [
    "origin\tgit@github.com:danya02/x.git (fetch)",
    "zzz\tgit@git.danya02.ru:danya/ci-demo.git (fetch)",
    "aaa\tssh://git@git.danya02.ru:2222/danya/other.git (fetch)",
    "",
  ].join("\n");
  const picked = forgejo.findForgeRemote(text, "git.danya02.ru");
  eq(picked.name, "aaa", "no matching origin -> alphabetical");
  eq(forgejo.findForgeRemote(text, "example.com"), null, "other hosts do not match");
  const withOrigin = [
    "zzz\tgit@git.danya02.ru:danya/ci-demo.git (fetch)",
    "origin\tssh://git@git.danya02.ru/danya/origin-repo.git (fetch)",
    "",
  ].join("\n");
  const t = forgejo.findForgeRemote(withOrigin, "git.danya02.ru");
  eq(t.name, "origin", "matching origin wins");
  eq(`${t.owner}/${t.repo}`, "danya/origin-repo");
});

// ---------------------------------------------------------------------------
// Unit: transport
// ---------------------------------------------------------------------------

await test("proxyFor: precedence, NO_PROXY, garbage", () => {
  const https = new URL("https://git.danya02.ru/api");
  const http = new URL("http://git.danya02.ru/api");
  eq(requestMod.proxyFor(https, { HTTPS_PROXY: "http://a:1" }).host, "a:1");
  eq(requestMod.proxyFor(https, { HTTPS_PROXY: "http://a:1", https_proxy: "http://b:2" }).host, "b:2");
  eq(requestMod.proxyFor(https, { HTTPS_PROXY: "http://a:1", NO_PROXY: "git.danya02.ru" }), null);
  eq(requestMod.proxyFor(https, { HTTPS_PROXY: "http://a:1", NO_PROXY: "danya02.ru" }), null, "suffix match bypasses");
  eq(requestMod.proxyFor(https, { HTTPS_PROXY: "http://a:1", NO_PROXY: "other.example" }).host, "a:1");
  eq(requestMod.proxyFor(https, { HTTPS_PROXY: "http://a:1", NO_PROXY: "*" }), null);
  eq(requestMod.proxyFor(https, { HTTPS_PROXY: "::::" }), null, "garbage proxy means direct");
  eq(requestMod.proxyFor(https, {}), null);
  eq(requestMod.proxyFor(http, { HTTPS_PROXY: "http://a:1" }), null, "https proxy must not catch http");
  eq(requestMod.proxyFor(http, { HTTP_PROXY: "http://c:3" }).host, "c:3");
});

await test("transport: GET and POST round-trip", async () => {
  routes = [
    { method: "GET", re: /\/echo(\?|$)/, handler: (b, url) => ({ body: { q: new URL(url, "http://x").searchParams.get("q") } }) },
    { method: "POST", re: /\/echo(\?|$)/, handler: (b) => ({ body: { echo: JSON.parse(b) } }) },
  ];
  const get = await requestMod.request("GET", `${origin}/echo?q=1`);
  eq(get.status, 200);
  eq(JSON.parse(get.body).q, "1");
  const post = await requestMod.request("POST", `${origin}/echo`, {
    body: JSON.stringify({ n: 42 }),
    headers: { "content-type": "application/json" },
  });
  eq(JSON.parse(post.body).echo.n, 42);
});

await test("transport: a stuck request is bounded by timeoutMs", async () => {
  routes = [{ method: "GET", re: /\/stuck$/, handler: () => ({ hang: true }) }];
  const t0 = Date.now();
  let err = null;
  try {
    await requestMod.request("GET", `${origin}/stuck`, { timeoutMs: 300 });
  } catch (caught) {
    err = caught;
  }
  ok(err !== null && /timed out/.test(err.message), `expected a timeout error, got ${err}`);
  ok(Date.now() - t0 < 2000, "the timeout must fire near its deadline");
});

// ---------------------------------------------------------------------------
// Unit: config resolution, attribution, formatting
// ---------------------------------------------------------------------------

await test("config: plugin options beat config.json beats defaults", async () => {
  writeFileSync(join(pluginConfigDir, "config.json"), JSON.stringify({ marker_label: "file-todo", request_timeout_seconds: 2 }));
  try {
    process.env.CLAUDE_PLUGIN_OPTION_MARKER_LABEL = "env-todo";
    let mod = await freshImport("forgejo.mjs");
    eq(mod.config.markerLabel, "env-todo", "env wins");
    eq(mod.config.timeoutMs, 2000, "config.json seconds -> ms");
    delete process.env.CLAUDE_PLUGIN_OPTION_MARKER_LABEL;
    mod = await freshImport("forgejo.mjs");
    eq(mod.config.markerLabel, "file-todo", "config.json wins over default");
    rmSync(join(pluginConfigDir, "config.json"));
    mod = await freshImport("forgejo.mjs");
    eq(mod.config.markerLabel, "agent-todo", "default");
    eq(mod.config.timeoutMs, 5000, "default ms");
  } finally {
    delete process.env.CLAUDE_PLUGIN_OPTION_MARKER_LABEL;
    rmSync(join(pluginConfigDir, "config.json"), { force: true });
  }
});

await test("token: plugin option beats env beats file beats nothing", () => {
  const saved = process.env.CLAUDE_FORGEJO_ISSUES_TOKEN;
  try {
    process.env.CLAUDE_PLUGIN_OPTION_FORGEJO_TOKEN = "opt-token-1";
    process.env.CLAUDE_FORGEJO_ISSUES_TOKEN = "env-token-2";
    eq(forgejo.readToken(), "opt-token-1");
    delete process.env.CLAUDE_PLUGIN_OPTION_FORGEJO_TOKEN;
    eq(forgejo.readToken(), "env-token-2");
    process.env.CLAUDE_FORGEJO_ISSUES_TOKEN = "";
    writeFileSync(join(pluginConfigDir, "token"), " file-token-3 \n");
    eq(forgejo.readToken(), "file-token-3");
    rmSync(join(pluginConfigDir, "token"));
    eq(forgejo.readToken(), null, "nothing anywhere -> null");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_FORGEJO_ISSUES_TOKEN;
    else process.env.CLAUDE_FORGEJO_ISSUES_TOKEN = saved;
    delete process.env.CLAUDE_PLUGIN_OPTION_FORGEJO_TOKEN;
    rmSync(join(pluginConfigDir, "token"), { force: true });
  }
});

await test("literal ${user_config.*} option values count as unset", async () => {
  const saved = process.env.CLAUDE_FORGEJO_ISSUES_TOKEN;
  try {
    process.env.CLAUDE_PLUGIN_OPTION_FORGE_HOST = "${user_config.forge_host}";
    let mod = await freshImport("forgejo.mjs");
    eq(mod.config.host, "git.danya02.ru", "placeholder host falls back to the default");

    process.env.CLAUDE_PLUGIN_OPTION_FORGEJO_TOKEN = "${user_config.forgejo_token}";
    process.env.CLAUDE_FORGEJO_ISSUES_TOKEN = "";
    eq(forgejo.readToken(), null, "placeholder token counts as missing");

    process.env.CLAUDE_PLUGIN_OPTION_FORGE_HOST = "pre${user_config.x}post";
    mod = await freshImport("forgejo.mjs");
    eq(mod.config.host, "pre${user_config.x}post", "partial embedding survives (whole-value match)");
  } finally {
    delete process.env.CLAUDE_PLUGIN_OPTION_FORGE_HOST;
    delete process.env.CLAUDE_PLUGIN_OPTION_FORGEJO_TOKEN;
    if (saved === undefined) delete process.env.CLAUDE_FORGEJO_ISSUES_TOKEN;
    else process.env.CLAUDE_FORGEJO_ISSUES_TOKEN = saved;
  }
});

await test("missingTokenMessage names the path, the URL and every storage choice", () => {
  const msg = forgejo.missingTokenMessage();
  includes(msg, "No Forgejo API token");
  includes(msg, join(pluginConfigDir, "token"));
  includes(msg, "user/settings/applications");
  includes(msg, "CLAUDE_FORGEJO_ISSUES_TOKEN");
});

await test("plugin.json userConfig and .mcp.json env map stay in sync", () => {
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const mcpJson = JSON.parse(readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"));
  const env = mcpJson.mcpServers.fj.env ?? {};
  const keys = Object.keys(manifest.userConfig);
  eq(keys.length, Object.keys(env).length, "exactly one env entry per userConfig key");
  for (const key of keys) {
    eq(env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`], `\${user_config.${key}}`, `env map carries ${key}`);
  }
  const prefix = `mcp__plugin_${manifest.name}_${Object.keys(mcpJson.mcpServers)[0]}__`;
  includes(readFileSync(new URL("../scripts/hook.mjs", import.meta.url), "utf8"), `const TOOL_PREFIX = "${prefix}";`, "hook tool prefix");
  eq(JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks.PreToolUse[0].matcher, `${prefix}.*`, "hook matcher");
});

await test("stripAttribution removes stacked footers and only footers", async () => {
  const { attribution, stripAttribution } = await freshImport("forgejo.mjs");
  const footer = attribution();
  eq(stripAttribution(`Body.${footer}${footer}\n`), { text: "Body.", attributed: true });
  eq(stripAttribution("Body.\n\n---\nnot ours"), { text: "Body.\n\n---\nnot ours", attributed: false });
  eq(stripAttribution(null), { text: "", attributed: false });
});

await test("attribution: session part follows its toggle", async () => {
  includes(forgejo.attribution(), `session \`${process.env.CLAUDE_CODE_SESSION_ID}\``);
  includes(forgejo.attribution(), "Written by Claude with");
  process.env.CLAUDE_PLUGIN_OPTION_ATTRIBUTION_SESSION = "false";
  let mod = await freshImport("forgejo.mjs");
  ok(!mod.attribution().includes("session `"), "session id suppressed");
  includes(mod.attribution(), "Written by Claude with");
  delete process.env.CLAUDE_PLUGIN_OPTION_ATTRIBUTION_SESSION;
  process.env.CLAUDE_PLUGIN_OPTION_ATTRIBUTION = "false";
  mod = await freshImport("forgejo.mjs");
  eq(mod.attribution(), "");
  delete process.env.CLAUDE_PLUGIN_OPTION_ATTRIBUTION;
});

await test("sessionRef accepts the UUID shape and rejects junk", async () => {
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.CLAUDE_CODE_SESSION_ID = "short";
    eq((await freshImport("forgejo.mjs")).sessionRef(), null);
    process.env.CLAUDE_CODE_SESSION_ID = "a1b2c3d4-0000-48ba-9cde-f01234567890";
    eq((await freshImport("forgejo.mjs")).sessionRef(), "a1b2c3d4-0000-48ba-9cde-f01234567890");
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = saved;
  }
});

await test("describeIssue and renderList formatting", () => {
  eq(forgejo.describeIssue({ number: 12, title: "T", labels: [{ name: "a" }, { name: "b" }] }), "#12 T [a, b]");
  eq(forgejo.describeIssue({ number: 13, title: "U", labels: [] }), "#13 U");
  eq(
    forgejo.renderList({ owner: "danya", repo: "ci-demo" }, [{ number: 4, title: "T", labels: [] }]),
    "Forgejo TODOs on git.danya02.ru/danya/ci-demo -- 1 open:\n#4 T"
  );
  eq(forgejo.renderList({ owner: "danya", repo: "ci-demo" }, []), "Forgejo TODOs on git.danya02.ru/danya/ci-demo -- none open.");
});

await test("safeId rejects path-shaped garbage", () => {
  eq(forgejo.safeId("0123abcd-4567"), "0123abcd-4567");
  let threw = false;
  try {
    forgejo.safeId("../evil");
  } catch {
    threw = true;
  }
  ok(threw, "path traversal must throw");
});

// ---------------------------------------------------------------------------
// Hook (as a real subprocess, with the fake git on PATH)
// ---------------------------------------------------------------------------

const HOOK_ENV = {
  PATH: `${binDir}:${process.env.PATH}`,
  FAKE_GIT_REMOTE: "origin\tssh://git@git.danya02.ru:2222/danya/ci-demo (fetch)",
};

let sidCounter = 0;
function nextSid() {
  sidCounter += 1;
  return `session-${String(sidCounter).padStart(3, "0")}-0000-4000-8000-000000000000`;
}

function hookInput(event, sessionId) {
  return { hook_event_name: event, session_id: sessionId, cwd: "/repo" };
}

// Async on purpose: spawnSync would block this process's event loop, and the
// stand-in forge lives IN this process -- a blocked loop means the child's
// requests to it deadlock until the child's request timeout fires.
function runHook(input, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...HOOK_ENV, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function hookOutput(result) {
  if (result.stdout.trim() === "") return null;
  return JSON.parse(result.stdout.trim().split("\n")[0]);
}

function hookContext(result) {
  return hookOutput(result)?.hookSpecificOutput?.additionalContext ?? null;
}

function hookUserMessage(result) {
  return hookOutput(result)?.systemMessage ?? null;
}

function readState(sid) {
  try {
    return JSON.parse(readFileSync(join(dataHome, "sessions", `${sid}.json`), "utf8"));
  } catch {
    return null;
  }
}

await test("hook SessionStart: full TODO block on a forge repo", async () => {
  routes = defaultRoutes();
  requests = [];
  const sid = nextSid();
  const r = await runHook(hookInput("SessionStart", sid));
  eq(r.code, 0, "exit code");
  includes(hookContext(r), "Forgejo TODOs on git.danya02.ru/danya/ci-demo -- 2 open:");
  includes(hookContext(r), "#4 Fix CI on main [agent-todo]");
  includes(hookContext(r), "#7 Add caching [agent-todo]");
  includes(hookUserMessage(r), "injected 2 open TODOs");
  ok(/\(Snapshot taken \d{4}-\d\d-\d\d \d\d:\d\d[+-]\d\d:\d\d; call list_issues/.test(hookContext(r)), "snapshot stamp");
  // The measured trap demands this exact order and the id-based filter:
  eq(requests, [
    "GET /api/v1/repos/danya/ci-demo/labels?limit=50&page=1",
    "GET /api/v1/repos/danya/ci-demo/issues?state=open&type=issues&labels=2&page=1&limit=50",
  ]);
  const state = readState(sid);
  eq(state.count, 2, "state seeds the per-prompt diff");
  eq(state.hash?.length, 64, "state carries the rendered-list hash");
});

await test("hook: absent marker label means a short hint and no issues query", async () => {
  routes = [{ method: "GET", re: /\/labels\?/, handler: () => ({ body: [] }) }];
  requests = [];
  const r = await runHook(hookInput("SessionStart", nextSid()));
  const out = JSON.parse(r.stdout);
  includes(out.hookSpecificOutput.additionalContext, "none open");
  includes(out.hookSpecificOutput.additionalContext, "create_issue");
  includes(out.systemMessage, "no TODOs yet");
  includes(out.hookSpecificOutput.additionalContext, "mcp__plugin_forgejo-issues_fj__create_issue", "exact tool name");
  eq(requests.some((q) => q.includes("/issues")), false, "never a name-filtered issues query");
});

await test("hook: non-forge repo is dormant before any network work", async () => {
  routes = defaultRoutes();
  requests = [];
  const t0 = Date.now();
  const r = await runHook(hookInput("SessionStart", nextSid()), {
    FAKE_GIT_REMOTE: "origin\tgit@github.com:danya02/claude-forgejo-issues.git (fetch)",
  });
  eq(r.stdout.trim(), "");
  eq(requests, [], "not even a label lookup");
  ok(Date.now() - t0 < 2000, `dormant run should be quick (node startup dominates); took ${Date.now() - t0} ms`);
});

await test("hook: per-prompt injection is opt-in and off by default", async () => {
  routes = defaultRoutes();
  requests = [];
  const r = await runHook(hookInput("UserPromptSubmit", nextSid()));
  eq(r.stdout.trim(), "");
  eq(requests, []);
});

await test("hook: opt-in per-prompt refresh diffs against the last injection", async () => {
  const opt = { CLAUDE_PLUGIN_OPTION_INJECT_ON_PROMPT: "true" };
  const sid = nextSid();
  routes = defaultRoutes();
  requests = [];
  const seed = await runHook(hookInput("SessionStart", sid), opt);
  includes(hookContext(seed), "#4");
  const same = await runHook(hookInput("UserPromptSubmit", sid), opt);
  includes(hookContext(same), "unchanged (2 open)");
  includes(hookUserMessage(same), "unchanged");
  routes = [
    { method: "GET", re: /\/labels\?/, handler: () => ({ body: [LABEL] }) },
    { method: "GET", re: /\/issues\?/, handler: () => ({ body: [ISSUE_A, ISSUE_B, ISSUE_C] }) },
  ];
  const moved = await runHook(hookInput("UserPromptSubmit", sid), opt);
  includes(hookContext(moved), "#9 Write the docs");
  eq(readState(sid).count, 3, "state follows the new list");
});

await test("hook: a distinct error reports once per session", async () => {
  const sid = nextSid();
  routes = [{ method: "GET", re: /\/labels\?/, handler: () => ({ status: 500, body: { message: "boom one" } }) }];
  requests = [];
  const first = await runHook(hookInput("SessionStart", sid));
  includes(hookContext(first), "forgejo-issues-error");
  includes(hookContext(first), "HTTP 500");
  includes(hookContext(first), "boom one", "body hint surfaces");
  const second = await runHook(hookInput("SessionStart", sid));
  eq(hookContext(second), null, "same error stays silent");
  routes = [{ method: "GET", re: /\/labels\?/, handler: () => ({ status: 503, body: { message: "boom two" } }) }];
  const third = await runHook(hookInput("SessionStart", sid));
  includes(hookContext(third), "HTTP 503", "a different error reports again");
});

await test("hook: missing token reports once and names the token path", async () => {
  rmSync(join(pluginConfigDir, "token"), { force: true });
  routes = [];
  requests = [];
  const sid = nextSid();
  const first = await runHook(hookInput("SessionStart", sid), { CLAUDE_FORGEJO_ISSUES_TOKEN: "" });
  includes(hookContext(first), "No Forgejo API token");
  includes(hookContext(first), join(pluginConfigDir, "token"));
  includes(hookContext(first), "user/settings/applications");
  const second = await runHook(hookInput("SessionStart", sid), { CLAUDE_FORGEJO_ISSUES_TOKEN: "" });
  eq(hookContext(second), null, "reported once per session");
  eq(requests, []);
});

await test("hook: token file (XDG seam) is honored when env is unset", async () => {
  writeFileSync(join(pluginConfigDir, "token"), " file-token-456 \n");
  routes = defaultRoutes();
  requests = [];
  const r = await runHook(hookInput("SessionStart", nextSid()), { CLAUDE_FORGEJO_ISSUES_TOKEN: "" });
  includes(hookContext(r), "#4 Fix CI on main");
});

await test("hook: a token in plugin options is used", async () => {
  rmSync(join(pluginConfigDir, "token"), { force: true });
  routes = defaultRoutes();
  requests = [];
  const r = await runHook(hookInput("SessionStart", nextSid()), {
    CLAUDE_FORGEJO_ISSUES_TOKEN: "",
    CLAUDE_PLUGIN_OPTION_FORGEJO_TOKEN: "opt-token-789",
  });
  includes(hookContext(r), "#4 Fix CI on main", "hook proceeded with the option token");
  eq(requests.length, 2, "labels + issues queried");
});

await test("hook: a tool call that waited on approval advises allowing the server, once", async () => {
  const sid = nextSid();
  const base = { session_id: sid, tool_use_id: "toolu_1", tool_name: "mcp__plugin_forgejo-issues_fj__add_comment", permission_mode: "default", cwd: "/x" };
  const run = (event) => runHook({ ...base, hook_event_name: event });
  const backdate = () => writeFileSync(join(dataHome, "sessions", `${sid}-toolu_1.stamp`), String(Date.now() - 60000));
  eq((await run("PreToolUse")).stdout.trim(), "", "pre is silent");
  eq((await run("PostToolUse")).stdout.trim(), "", "a fast call says nothing");
  await run("PreToolUse");
  backdate();
  const slow = JSON.parse((await run("PostToolUse")).stdout);
  includes(slow.hookSpecificOutput.additionalContext, '"mcp__plugin_forgejo-issues_fj"');
  includes(slow.systemMessage, "likely on approval");
  await run("PreToolUse");
  backdate();
  eq((await run("PostToolUse")).stdout.trim(), "", "said once per session");
});

await test("hook: malformed stdin exits 0 silently", () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: "not json at all",
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...HOOK_ENV },
  });
  eq(r.status, 0);
  eq(r.stdout.trim(), "");
});

// ---------------------------------------------------------------------------
// MCP server (real subprocess, line-delimited JSON-RPC)
// ---------------------------------------------------------------------------

const MCP_ENV = {
  PATH: `${binDir}:${process.env.PATH}`,
  FAKE_GIT_REMOTE: "origin\tssh://git@git.danya02.ru:2222/danya/ci-demo (fetch)",
  CLAUDE_PROJECT_DIR: "/repo",
};

function makeMcp(extraEnv = {}) {
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, ...MCP_ENV, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = [];
  const stray = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === "") continue;
      const wake = waiters.shift();
      if (wake) wake(JSON.parse(line));
      else stray.push(line);
    }
  });
  child.stderr.on("data", () => {}); // drained, never asserted
  let rpcId = 100;
  return {
    child,
    stray,
    // Sends one request (id injected) and resolves with the next reply line.
    call(body) {
      rpcId += 1;
      const msg = { jsonrpc: "2.0", id: rpcId, ...body };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout on ${JSON.stringify(body).slice(0, 80)}`)), 5000);
        waiters.push((parsed) => {
          clearTimeout(timer);
          resolve(parsed);
        });
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      });
    },
    sendOnly(obj) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    writeRaw(text) {
      child.stdin.write(text);
    },
    async waitForLine(timeoutMs = 5000) {
      if (buffer.includes("\n")) {
        const line = buffer.slice(0, buffer.indexOf("\n")).trim();
        buffer = buffer.slice(buffer.indexOf("\n") + 1);
        if (line !== "") return JSON.parse(line);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP: no line arrived")), timeoutMs);
        waiters.push((parsed) => {
          clearTimeout(timer);
          resolve(parsed);
        });
      });
    },
    stop() {
      child.stdin.end();
    },
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code))),
  };
}

let m = null;

await test("mcp: not a forge repo offers only the status tool", () => {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status", arguments: {} } },
  ];
  const r = spawnSync(process.execPath, [MCP], {
    input: msgs.map((x) => JSON.stringify(x)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      ...MCP_ENV,
      FAKE_GIT_REMOTE: "origin\tgit@github.com:danya02/elsewhere.git (fetch)",
    },
  });
  eq(r.status, 0);
  const [init, list, call] = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  includes(init.result.instructions, "Not active here");
  eq(list.result.tools.map((t) => t.name), ["status"]);
  includes(call.result.content[0].text, "git remote add");
});

await test("mcp: initialize and tools/list", async () => {
  routes = defaultRoutes();
  requests = [];
  m = makeMcp();
  const init = await m.call({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  eq(init.result.protocolVersion, "2025-06-18");
  eq(init.result.serverInfo.name, "forgejo-issues");
  m.sendOnly({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = await m.call({ method: "tools/list" });
  eq(tools.result.tools.map((t) => t.name).sort(), ["add_comment", "create_issue", "edit_issue", "get_issue", "list_issues", "set_issue_state"]);
  ok(tools.result.tools.every((t) => t.title && t.annotations), "every tool has a title and annotations");
  includes(init.result.instructions, "danya/ci-demo");
  const manifest = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  eq(init.result.serverInfo.version, manifest.version, "version read from plugin.json");
  const ping = await m.call({ method: "ping" });
  eq(ping.result, {});
});

await test("mcp: list_issues default view filters by label id", async () => {
  routes = defaultRoutes();
  requests = [];
  const res = await m.call({ method: "tools/call", params: { name: "list_issues", arguments: {} } });
  eq(res.error, undefined);
  eq(res.result.isError, undefined);
  includes(res.result.content[0].text, "#4 Fix CI on main [agent-todo]");
  eq(requests, [
    "GET /api/v1/repos/danya/ci-demo/labels?limit=50&page=1",
    "GET /api/v1/repos/danya/ci-demo/issues?state=open&type=issues&labels=2&page=1&limit=50",
  ]);
});

await test("mcp: list_issues query passes q= (quotes stripped) alongside the label id", async () => {
  routes = defaultRoutes();
  requests = [];
  const res = await m.call({ method: "tools/call", params: { name: "list_issues", arguments: { query: '"maze map"', state: "all" } } });
  includes(res.result.content[0].text, 'listed matching "\\"maze map\\""');
  eq(requests[1], "GET /api/v1/repos/danya/ci-demo/issues?state=all&type=issues&labels=2&q=maze%20map&page=1&limit=50");
});

await test("mcp: list_issues all:true skips label resolution", async () => {
  routes = [{ method: "GET", re: /\/issues\?/, handler: () => ({ body: [ISSUE_A, ISSUE_B] }) }];
  requests = [];
  const res = await m.call({ method: "tools/call", params: { name: "list_issues", arguments: { all: true } } });
  eq(requests.some((q) => q.includes("/labels")), false, "no label lookup in the widened view");
  includes(res.result.content[0].text, "2 open:");
});

await test("mcp: list_issues with absent label explains without querying issues", async () => {
  routes = [{ method: "GET", re: /\/labels\?/, handler: () => ({ body: [] }) }];
  requests = [];
  const res = await m.call({ method: "tools/call", params: { name: "list_issues", arguments: {} } });
  includes(res.result.content[0].text, "does not exist yet");
  eq(requests.some((q) => q.includes("/issues")), false);
});

await test("mcp: get_issue returns body and comments; 404 is a tool error", async () => {
  const FULL = { number: 4, title: "Fix CI on main", state: "open", body: "The pipeline is red.", labels: [LABEL], html_url: "u/4" };
  routes = [
    { method: "GET", re: /\/issues\/4$/, handler: () => ({ body: FULL }) },
    { method: "GET", re: /\/issues\/4\/comments/, handler: () => ({ body: [{ user: { login: "danya" }, created_at: "2026-01-01T00:00:00Z", body: "started on it" }] }) },
    { method: "GET", re: /\/issues\/999$/, handler: () => ({ status: 404, body: { message: "Not found" } }) },
  ];
  const res = await m.call({ method: "tools/call", params: { name: "get_issue", arguments: { number: 4 } } });
  const text = res.result.content[0].text;
  includes(text, "#4 Fix CI on main (open)");
  includes(text, "The pipeline is red.");
  includes(text, "started on it");
  includes(text, "danya");
  const missing = await m.call({ method: "tools/call", params: { name: "get_issue", arguments: { number: 999 } } });
  eq(missing.result.isError, true);
  includes(missing.result.content[0].text, "does not exist");
});

await test("mcp: create_issue tags the label and appends attribution", async () => {
  let issueBody = null;
  routes = [
    { method: "GET", re: /\/labels\?/, handler: () => ({ body: [LABEL] }) },
    {
      method: "POST",
      re: /\/issues$/,
      handler: (b) => {
        issueBody = JSON.parse(b);
        return { status: 201, body: { number: 12, title: issueBody.title, html_url: "u/12" } };
      },
    },
  ];
  const res = await m.call({ method: "tools/call", params: { name: "create_issue", arguments: { title: "New TODO", body: "Details." } } });
  includes(res.result.content[0].text, "Created #12");
  eq(issueBody.labels, [2], "inline label id");
  eq(issueBody.title, "New TODO");
  includes(issueBody.body, "Details.");
  includes(issueBody.body, "Written by Claude with");
  includes(issueBody.body, "github.com/danya02/claude-forgejo-issues");
  includes(issueBody.body, process.env.CLAUDE_CODE_SESSION_ID, "session id present");
});

await test("mcp: create_issue creates an absent marker label (and survives a 422 race)", async () => {
  let labelBody = null;
  let labelFetches = 0;
  let issueBody = null;
  routes = [
    {
      method: "GET",
      re: /\/labels\?/,
      handler: () => {
        labelFetches += 1;
        return { body: labelFetches === 1 ? [] : [{ id: 5, name: "agent-todo" }] };
      },
    },
    {
      method: "POST",
      re: /\/labels$/,
      handler: (b) => {
        labelBody = JSON.parse(b);
        return { status: 422, body: { message: "label already exists" } };
      },
    },
    {
      method: "POST",
      re: /\/issues$/,
      handler: (b) => {
        issueBody = JSON.parse(b);
        return { status: 201, body: { number: 13, title: "T", html_url: "u/13" } };
      },
    },
  ];
  const res = await m.call({ method: "tools/call", params: { name: "create_issue", arguments: { title: "With fresh label" } } });
  includes(res.result.content[0].text, "Created #13");
  eq(labelBody.name, "agent-todo");
  eq(issueBody.labels, [5], "re-resolved id used");
});

await test("mcp: edit_issue patches only given fields and validates", async () => {
  let patch = null;
  routes = [
    {
      method: "PATCH",
      re: /\/issues\/4$/,
      handler: (b) => {
        patch = JSON.parse(b);
        return { status: 201, body: { number: 4, title: "Renamed" } };
      },
    },
  ];
  const res = await m.call({ method: "tools/call", params: { name: "edit_issue", arguments: { number: 4, title: "Renamed", state: "closed" } } });
  includes(res.result.content[0].text, "Updated #4");
  eq(patch, { title: "Renamed", state: "closed" });
  const { attribution } = await freshImport("forgejo.mjs");
  await m.call({ method: "tools/call", params: { name: "edit_issue", arguments: { number: 4, body: `Read back.${attribution()}` } } });
  eq(patch.body.match(/Written by Claude with/g)?.length, 1, "a read-back footer is replaced, not stacked");
  const empty = await m.call({ method: "tools/call", params: { name: "edit_issue", arguments: { number: 4 } } });
  eq(empty.result.isError, true);
  includes(empty.result.content[0].text, "Nothing to update");
  const bad = await m.call({ method: "tools/call", params: { name: "edit_issue", arguments: { number: 4, state: "closedd" } } });
  includes(bad.result.content[0].text, 'state must be "open" or "closed"');
});

await test("mcp: edit_issue append reads, appends before the footer, patches", async () => {
  const { attribution } = await freshImport("forgejo.mjs");
  const order = [];
  let patch = null;
  routes = [
    {
      method: "GET",
      re: /\/issues\/4$/,
      handler: () => {
        order.push("GET");
        return { body: { number: 4, title: "T", body: `Original text.\n${attribution()}` } };
      },
    },
    {
      method: "PATCH",
      re: /\/issues\/4$/,
      handler: (b) => {
        order.push("PATCH");
        patch = JSON.parse(b);
        return { status: 201, body: { number: 4, title: "T" } };
      },
    },
  ];
  const res = await m.call({ method: "tools/call", params: { name: "edit_issue", arguments: { number: 4, append: "## Update\nMore." } } });
  includes(res.result.content[0].text, "Updated #4");
  eq(order, ["GET", "PATCH"]);
  includes(res.result.content[0].text, "body now 31 chars");
  includes(patch.body, "Original text.\n\n## Update\nMore.");
  eq(patch.body.match(/Written by Claude with/g)?.length, 1, "single footer, at the end");
  const both = await m.call({ method: "tools/call", params: { name: "edit_issue", arguments: { number: 4, body: "x", append: "y" } } });
  eq(both.result.isError, true);
});

await test("mcp: add_comment and set_issue_state", async () => {
  let commentBody = null;
  let patch = null;
  routes = [
    {
      method: "POST",
      re: /\/issues\/4\/comments/,
      handler: (b) => {
        commentBody = JSON.parse(b);
        return { status: 201, body: { id: 1 } };
      },
    },
    {
      method: "PATCH",
      re: /\/issues\/4$/,
      handler: (b) => {
        patch = JSON.parse(b);
        return { status: 201, body: { number: 4, title: "Fix CI on main" } };
      },
    },
  ];
  const res = await m.call({ method: "tools/call", params: { name: "add_comment", arguments: { number: 4, body: "Did the thing." } } });
  includes(res.result.content[0].text, "Commented on #4");
  includes(commentBody.body, "Did the thing.");
  includes(commentBody.body, "Written by Claude with");
  const st = await m.call({ method: "tools/call", params: { name: "set_issue_state", arguments: { number: 4, state: "open" } } });
  includes(st.result.content[0].text, "Reopened #4");
  eq(patch, { state: "open" });
  commentBody = null;
  const withC = await m.call({ method: "tools/call", params: { name: "set_issue_state", arguments: { number: 4, state: "closed", comment: "Done in abc123." } } });
  includes(withC.result.content[0].text, "Closed #4");
  includes(commentBody.body, "Done in abc123.");
  eq(requests.slice(-2).map((r) => r.split(" ")[0]), ["POST", "PATCH"], "comment before state");
});

await test("mcp: set_issue_state reports which arm failed", async () => {
  let patched = false;
  routes = [
    { method: "POST", re: /\/issues\/4\/comments/, handler: () => ({ status: 500, body: { message: "boom" } }) },
    { method: "PATCH", re: /\/issues\/4$/, handler: () => ((patched = true), { status: 201, body: { number: 4, title: "T" } }) },
  ];
  const a = await m.call({ method: "tools/call", params: { name: "set_issue_state", arguments: { number: 4, state: "closed", comment: "x" } } });
  includes(a.result.content[0].text, "Comment failed, state not changed");
  eq(patched, false);
  routes = [
    { method: "POST", re: /\/issues\/4\/comments/, handler: () => ({ status: 201, body: { id: 1 } }) },
    { method: "PATCH", re: /\/issues\/4$/, handler: () => ({ status: 500, body: { message: "boom" } }) },
  ];
  const b = await m.call({ method: "tools/call", params: { name: "set_issue_state", arguments: { number: 4, state: "closed", comment: "x" } } });
  includes(b.result.content[0].text, "Comment posted, but the state change failed");
});

await test("mcp: unknown tool -32602, unknown method -32601, bad JSON -32700, notifications silent", async () => {
  const unknownTool = await m.call({ method: "tools/call", params: { name: "nonexistent", arguments: {} } });
  eq(unknownTool.error?.code, -32602);
  const unknownMethod = await m.call({ method: "resources/list" });
  eq(unknownMethod.error?.code, -32601);
  const garbageLine = m.waitForLine();
  m.writeRaw("this is not json\n");
  const parseErr = await garbageLine;
  eq(parseErr.error?.code, -32700);
  eq(parseErr.id, null);
  m.sendOnly({ jsonrpc: "2.0", method: "notifications/other" }); // must not reply
  const ping = await m.call({ method: "ping" });
  eq(ping.result, {}, "notification produced no line before the ping reply");
});

await test("mcp: token absence is a clean tool error, not a dead server", async () => {
  const noToken = makeMcp({ CLAUDE_FORGEJO_ISSUES_TOKEN: "", XDG_CONFIG_HOME: emptyConfigHome });
  try {
    const init = await noToken.call({ method: "initialize", params: {} });
    eq(init.result.serverInfo.name, "forgejo-issues", "handshake succeeds without a token");
    const res = await noToken.call({ method: "tools/call", params: { name: "list_issues", arguments: {} } });
    eq(res.result.isError, true);
    includes(res.result.content[0].text, "No Forgejo API token");
    includes(res.result.content[0].text, "user/settings/applications");
  } finally {
    noToken.stop();
    eq(await noToken.exited, 0);
  }
});

await test("mcp: session attribution can be disabled per install", async () => {
  const noSess = makeMcp({ CLAUDE_PLUGIN_OPTION_ATTRIBUTION_SESSION: "false" });
  try {
    await noSess.call({ method: "initialize", params: {} });
    let issueBody = null;
    routes = [
      { method: "GET", re: /\/labels\?/, handler: () => ({ body: [LABEL] }) },
      {
        method: "POST",
        re: /\/issues$/,
        handler: (b) => {
          issueBody = JSON.parse(b);
          return { status: 201, body: { number: 14, title: "T", html_url: "u/14" } };
        },
      },
    ];
    await noSess.call({ method: "tools/call", params: { name: "create_issue", arguments: { title: "No session ref" } } });
    includes(issueBody.body, "Written by Claude with");
    ok(!issueBody.body.includes("session `"), "no session id");
  } finally {
    noSess.stop();
    eq(await noSess.exited, 0);
  }
});

await test("mcp: clean exit when stdin closes", async () => {
  m.stop();
  eq(await m.exited, 0);
  eq(m.stray, [], "every reply line was consumed by a waiting assertion");
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

server.close();
server.closeAllConnections?.();
rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
process.exit(0);
