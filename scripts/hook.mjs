// SessionStart / UserPromptSubmit hook: inject the forge repo's open TODOs
// as context at session start, and (opt-in) refresh on every prompt.
//
// Dormant by design outside a forge repo, and silent when silence IS the
// right answer (label absent = zero TODOs). Operational failures surface as
// a distinct-error-reported-once note; nothing ever blocks, nothing exits
// non-zero.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  config,
  forgeClient,
  listIssues,
  logError,
  missingTokenMessage,
  readSessionState,
  readToken,
  renderList,
  resolveLabel,
  resolveTarget,
  writeSessionState,
} from "./forgejo.mjs";

// contextText goes to the model (additionalContext); userMessage is the
// visible line (systemMessage), so the hook's work and its failures are
// observable in the transcript without inspecting the context.
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
  if (label.id === null) return; // label absent = zero TODOs: silence IS correct

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

  emit(
    event,
    text,
    `forgejo-issues: injected ${items.length} open TODO${items.length === 1 ? "" : "s"} from ${target.owner}/${target.repo}`
  );
  if (sessionId !== null) writeSessionState(sessionId, { hash, count: items.length });
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

main().catch((err) => {
  // Last-resort guard: a hook crash must look like "hook said nothing",
  // never like a failed prompt.
  logError("hook", err);
  process.exit(0);
});
