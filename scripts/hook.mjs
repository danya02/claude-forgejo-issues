// SessionStart / UserPromptSubmit hook: inject the forge repo's open TODOs
// as context at session start, and (opt-in) refresh on every prompt.
// PreToolUse / PostToolUse on the plugin's own tools: notice a call that sat
// behind an approval prompt and tell the user, once, how to allow the tools.
//
// Dormant by design outside a forge repo, and silent when silence IS the
// right answer (label absent = zero TODOs). Operational failures surface as
// a distinct-error-reported-once note; nothing ever blocks, nothing exits
// non-zero.

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  config,
  dataDir,
  forgeClient,
  listIssues,
  logError,
  missingTokenMessage,
  readSessionState,
  readToken,
  renderList,
  resolveLabel,
  resolveTarget,
  safeId,
  writeAtomic,
  writeSessionState,
} from "./forgejo.mjs";

// Appended to the injected list at session start, so the list comes with
// what to do about it. Not part of the hash: it never changes the diff.
// Tool names as the agent must call them: plugin registration mangles them
// to mcp__plugin_<plugin>_<server>__<tool>, which the agent cannot guess.
const TOOL_PREFIX = "mcp__plugin_forgejo-issues_fj__";
const USAGE =
  `Work on these through the Forgejo tools: ${TOOL_PREFIX}add_comment for progress, ` +
  `${TOOL_PREFIX}set_issue_state "closed" once the work is verified, ${TOOL_PREFIX}create_issue ` +
  `for follow-ups or anything the user asks to note down (${TOOL_PREFIX}list_issues, get_issue, edit_issue also exist).`;

// contextText goes to the model (additionalContext); userMessage is the
// visible line (systemMessage, top-level -- not inside hookSpecificOutput),
// so the hook's work and its failures are observable in the transcript
// without inspecting the context. Every injection carries one: the user
// should be able to see the hook is alive.
function emit(event, contextText, userMessage = null) {
  const payload = {
    hookSpecificOutput: { hookEventName: event, additionalContext: contextText },
  };
  if (userMessage !== null) payload.systemMessage = userMessage;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return; // malformed input: silence (never blocks)
  }
  const event = payload?.hook_event_name;
  if (event === "PreToolUse" || event === "PostToolUse") return permissionWatch(payload);
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return;
  // Per-prompt refresh is opt-in; when off, bail before even spawning git.
  if (event === "UserPromptSubmit" && !config.injectOnPrompt) return;

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const state = sessionId === null ? {} : readSessionState(sessionId);

  // The gate: not a forge repo -> dormant, before any token or HTTP work.
  const target = resolveTarget(payload.cwd);
  if (!target) return;

  const token = readToken();
  if (!token) {
    reportOnce(event, sessionId, state, missingTokenMessage());
    return;
  }

  const client = forgeClient(target, token);
  const label = await resolveLabel(client, config.markerLabel);
  if (label.error) {
    reportOnce(event, sessionId, state, label.error);
    return;
  }
  if (label.id === null) {
    // Label absent = zero TODOs. Silent per prompt, but at session start say
    // the tracker exists: with nothing listed, nothing else would.
    if (event === "SessionStart") {
      emit(
        event,
        `${renderList(target, [])} TODOs for this repo live there as issues labelled "${config.markerLabel}"; ` +
          `use ${TOOL_PREFIX}create_issue for follow-up work or anything the user asks to note down.`,
        `forgejo-issues: no TODOs yet on ${target.owner}/${target.repo}`
      );
    }
    return;
  }

  const { items, error } = await listIssues(client, { state: "open", labelId: label.id });
  if (error) {
    reportOnce(event, sessionId, state, error);
    return;
  }

  const text = renderList(target, items);
  const hash = createHash("sha256").update(text).digest("hex");

  if (event === "UserPromptSubmit" && state.hash === hash) {
    emit(
      event,
      `claude-forgejo-issues: TODO list unchanged (${items.length} open).`,
      `forgejo-issues: TODOs unchanged (${items.length} open)`
    );
    return;
  }

  // Stamped after hashing, so the time alone never counts as a change.
  const snapshot = `${text}\n${snapshotNote()}`;
  emit(
    event,
    event === "SessionStart" ? `${snapshot}\n${USAGE}` : snapshot,
    `forgejo-issues: injected ${items.length} open TODO${items.length === 1 ? "" : "s"} from ${target.owner}/${target.repo}`
  );
  if (sessionId !== null) writeSessionState(sessionId, { hash, count: items.length });
}

// The list goes stale as soon as anyone writes to the tracker; say when it
// was taken, in local time with the offset so it compares to the clock.
function snapshotNote(now = new Date()) {
  const p = (x) => String(x).padStart(2, "0");
  const off = -now.getTimezoneOffset();
  const tz = `${off < 0 ? "-" : "+"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}${tz}`;
  return `(Snapshot taken ${stamp}; call list_issues for the current state.)`;
}

// A distinct error reports once per session: identical text stays silent on
// repeat, a different error reports again. A success overwrites the stored
// error, so after recovery the same error may report again -- reporting
// means "something is wrong", not "once ever".
function reportOnce(event, sessionId, state, message) {
  if (state.error === message) return; // already reported this session
  try {
    if (sessionId !== null) writeSessionState(sessionId, { ...state, error: message });
    emit(
      event,
      `<forgejo-issues-error>claude-forgejo-issues: ${message}</forgejo-issues-error>`,
      `forgejo-issues: ${message}`
    );
  } catch {
    // reporting must never be the thing that fails
  }
}

// A permission dialog is invisible to a hook, but the wait for one is not:
// PreToolUse fires before the prompt is raised, so the gap to PostToolUse
// contains the user's decision. Measured in super-edit (same harness): an
// ungated call takes milliseconds, a gated one ~6s before the dialog even
// shows. The Forgejo round-trip adds up to the request timeout, so the
// threshold sits above it.
const PROMPTING_MODES = new Set(["default", "acceptEdits"]);

function permissionWatch(payload) {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const callId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : "call";
  if (sessionId === null) return;
  let stamp;
  try {
    stamp = join(dataDir, "sessions", `${safeId(sessionId)}-${safeId(callId)}.stamp`);
  } catch {
    return;
  }
  if (payload.hook_event_name === "PreToolUse") {
    writeAtomic(stamp, String(Date.now()));
    return;
  }
  let started = NaN;
  try {
    started = Number(readFileSync(stamp, "utf8"));
    unlinkSync(stamp);
  } catch {
    return;
  }
  const mode = String(payload.permission_mode ?? "");
  if (mode && !PROMPTING_MODES.has(mode)) return;
  const waited = Date.now() - started;
  if (!(waited >= config.timeoutMs + 3000)) return;
  const state = readSessionState(sessionId);
  if (state.permAdvised) return;
  writeSessionState(sessionId, { ...state, permAdvised: true });
  const server = String(payload.tool_name ?? "").split("__").slice(0, -1).join("__") || "mcp__plugin_forgejo-issues_fj";
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `That forgejo-issues call took ${(waited / 1000).toFixed(1)}s, so it most likely waited for the user to approve it. ` +
          `Tell them in one sentence (this is for them, not you): every issue update will ask again unless they allow the server, ` +
          `e.g. { "permissions": { "allow": ["${server}"] } } in .claude/settings.json (applies from the next session), ` +
          `or the dialog's option to allow for this session.`,
      },
      systemMessage: `forgejo-issues: that call waited ${(waited / 1000).toFixed(1)}s, likely on approval; allow ${server} to skip the prompt`,
    })}\n`
  );
}

main().catch((err) => {
  // Last-resort guard: a hook crash must look like "hook said nothing",
  // never like a failed prompt.
  logError("hook", err);
  process.exit(0);
});
