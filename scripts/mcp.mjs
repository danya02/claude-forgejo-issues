// MCP stdio server: six issue-tracker tools over the Forgejo API.
//
// Gate: the server starts only in a repo whose git remotes point at the
// configured forge host; otherwise it exits 0 before the handshake. What
// Claude Code shows for a server that exits during startup is an empirical
// question -- tests/MANUAL.md records what to observe and the fallback
// design (tools answering "not a forge repo") if tools end up
// listed-but-failing.

import { createInterface } from "node:readline";
import {
  attribution,
  config,
  createMarkerLabel,
  forgeClient,
  listIssues,
  logError,
  missingTokenMessage,
  paginate,
  readToken,
  renderList,
  resolveLabel,
  resolveTarget,
} from "./forgejo.mjs";

// Keep in sync with .claude-plugin/plugin.json.
const VERSION = "0.2.0";

// The gate. CLAUDE_PROJECT_DIR is the repo Claude Code launched in; the
// fallback covers bare `node mcp.mjs` runs.
const TARGET = resolveTarget(process.env.CLAUDE_PROJECT_DIR || process.cwd());
if (!TARGET) process.exit(0);

// A missing token does NOT exit: the handshake still succeeds so the failure
// lands in the tools as clean, readable errors -- not as a dead server.
// (Read lazily on every call so a token added mid-session is picked up.)

// ---------------------------------------------------------------------------
// JSON-RPC plumbing: line-delimited JSON on stdin/stdout
// ---------------------------------------------------------------------------

// Notifications (no id) get no reply. The process exits once stdin closes
// and no tool call is pending -- a pending write must never be cut off.
let pending = 0;
let stdinEnded = false;

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", handleLine);
rl.on("close", () => {
  stdinEnded = true;
  if (pending === 0) process.exit(0);
});

function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  const { id, method, params } = msg;
  if (typeof method !== "string") {
    if (id !== undefined && id !== null) {
      reply({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
    }
    return;
  }
  // A notification (no id) is acted on, never answered.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      reply({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "forgejo-issues", version: VERSION },
        },
      });
      return;
    case "ping":
      reply({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) {
        reply({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${JSON.stringify(name ?? null)}` },
        });
        return;
      }
      pending += 1;
      callTool(String(name), params?.arguments ?? {})
        .then((result) => reply({ jsonrpc: "2.0", id, result }))
        .catch((err) => {
          // Tool-level surprises become tool errors, never protocol errors:
          // an isError result is readable and actionable for the model.
          logError(`mcp:${name}`, err);
          reply({
            jsonrpc: "2.0",
            id,
            result: { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] },
          });
        })
        .finally(() => {
          pending -= 1;
          if (stdinEnded && pending === 0) process.exit(0);
        });
      return;
    }
    default:
      reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// Issue numbers arrive from the model as numbers or numeric strings.
function toNumber(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function stateCountLabel(state) {
  return state === "all" ? "listed" : state;
}

const TOOLS = [
  {
    name: "list_issues",
    description:
      `List the TODOs in this repo's Forgejo tracker: one line per issue (number, title, labels). ` +
      `Use when the session-start list is not enough -- before planning work, when the user asks what is open, ` +
      `or to re-check after edits. Default view: open issues carrying the "${config.markerLabel}" label ` +
      `(this plugin's marker for agent TODOs). Pass all:true to widen to every issue in the repo, ` +
      `or state:"closed"/"all" to change the state filter.`,
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          default: "open",
          description: "State filter.",
        },
        all: {
          type: "boolean",
          default: false,
          description: `Widen beyond the "${config.markerLabel}" label to every issue in the repo.`,
        },
      },
    },
  },
  {
    name: "get_issue",
    description:
      `Read one issue in full: description, labels, state and (by default) its comment thread. ` +
      `Use before editing an issue so the edit lands on current content, and whenever a list line is not enough.`,
    inputSchema: {
      type: "object",
      required: ["number"],
      properties: {
        number: { type: "integer", description: "Issue number, e.g. 4." },
        include_comments: {
          type: "boolean",
          default: true,
          description: "Set false to skip the comment thread.",
        },
      },
    },
  },
  {
    name: "create_issue",
    description:
      `Create a TODO issue. It is tagged with the "${config.markerLabel}" label automatically ` +
      `(the label is created on first use), and the body gets a short attribution line, ` +
      `so agent TODOs are distinguishable from the user's own issues. ` +
      `Use for every "note this down" / "TODO" request in this repo; keep titles short and imperative.`,
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Short imperative title." },
        body: {
          type: "string",
          description: "Full description in Markdown; the attribution line is appended.",
        },
      },
    },
  },
  {
    name: "edit_issue",
    description:
      `Edit an existing issue's title, body or state; at least one field is required. ` +
      `A replacement body also gets the attribution line. For discussion or progress notes prefer add_comment.`,
    inputSchema: {
      type: "object",
      required: ["number"],
      properties: {
        number: { type: "integer", description: "Issue number." },
        title: { type: "string" },
        body: {
          type: "string",
          description: "Replacement body in Markdown; the attribution line is appended.",
        },
        state: { type: "string", enum: ["open", "closed"] },
      },
    },
  },
  {
    name: "add_comment",
    description:
      `Add a comment to an issue: progress notes, findings, decisions. ` +
      `The comment gets the attribution line. Lighter than editing: the issue body's history stays intact.`,
    inputSchema: {
      type: "object",
      required: ["number", "body"],
      properties: {
        number: { type: "integer", description: "Issue number." },
        body: {
          type: "string",
          description: "Comment text in Markdown; the attribution line is appended.",
        },
      },
    },
  },
  {
    name: "set_issue_state",
    description:
      `Close or reopen an issue. Closing is how a TODO is finished: pass state:"closed" ` +
      `once the work is verified (committed, tests green); reopen with state:"open".`,
    inputSchema: {
      type: "object",
      required: ["number", "state"],
      properties: {
        number: { type: "integer", description: "Issue number." },
        state: {
          type: "string",
          enum: ["open", "closed"],
          description: `"closed" when the TODO is done, "open" to reopen.`,
        },
      },
    },
  },
];

async function callTool(name, args) {
  const token = readToken();
  if (!token) return toolError(missingTokenMessage());
  const client = forgeClient(TARGET, token);
  switch (name) {
    case "list_issues":
      return await listIssuesTool(client, args);
    case "get_issue":
      return await getIssueTool(client, args);
    case "create_issue":
      return await createIssueTool(client, args);
    case "edit_issue":
      return await editIssueTool(client, args);
    case "add_comment":
      return await addCommentTool(client, args);
    case "set_issue_state":
      return await setIssueStateTool(client, args);
  }
}

async function listIssuesTool(client, args) {
  const state = args.state === undefined ? "open" : args.state;
  if (state !== "open" && state !== "closed" && state !== "all") {
    return toolError(`state must be "open", "closed" or "all", got ${JSON.stringify(state)}`);
  }
  const countLabel = stateCountLabel(state);
  if (args.all !== true) {
    const label = await resolveLabel(client, config.markerLabel);
    if (label.error) return toolError(label.error);
    if (label.id === null) {
      // Absent marker label = zero TODOs, reported without querying issues
      // (a name-based filter is unsafe -- see scripts/forgejo.mjs rules).
      // Not auto-created here: creation is create_issue's job, listing must
      // stay read-only.
      return textResult(
        `${renderList(TARGET, [], countLabel)}\n(The "${config.markerLabel}" label does not exist yet; it is created automatically on first create_issue.)`
      );
    }
    const { items, error } = await listIssues(client, { state, labelId: label.id });
    if (error) return toolError(error);
    return textResult(renderList(TARGET, items, countLabel));
  }
  const { items, error } = await listIssues(client, { state, labelId: null });
  if (error) return toolError(error);
  return textResult(renderList(TARGET, items, countLabel));
}

async function getIssueTool(client, args) {
  const n = toNumber(args.number);
  if (n === null) return toolError("number must be a positive integer issue number");
  const { status, data, error } = await client.call("GET", `/issues/${n}`);
  if (error) {
    return toolError(
      status === 404
        ? `Issue #${n} does not exist on ${config.host}/${TARGET.owner}/${TARGET.repo}.`
        : error
    );
  }
  const labelNames = Array.isArray(data.labels)
    ? data.labels.map((l) => String(l?.name ?? "")).filter(Boolean)
    : [];
  const lines = [
    `#${data.number} ${data.title} (${data.state})`,
    `Labels: ${labelNames.length > 0 ? labelNames.join(", ") : "(none)"}`,
    `URL: ${data.html_url ?? ""}`,
    "",
    typeof data.body === "string" && data.body !== "" ? data.body : "(no description)",
  ];
  let tail = "";
  if (args.include_comments !== false) {
    const { items, error: cErr } = await paginate(client, `/issues/${n}/comments`);
    if (cErr) {
      // The issue body is already in hand: a comment failure degrades the
      // result, it does not discard it.
      tail = `\n\n(Comments unavailable: ${cErr})`;
    } else if (items.length > 0) {
      tail = `\n\n## Comments\n${items
        .map((c) => `**${c.user?.login ?? "unknown"}** (${c.created_at ?? "unknown date"}):\n${c.body ?? ""}`)
        .join("\n\n")}`;
    }
  }
  return textResult(lines.join("\n") + tail);
}

async function createIssueTool(client, args) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title === "") return toolError("title is required");
  const body = typeof args.body === "string" ? args.body : "";

  // Marker label: resolve; create when absent; re-resolve afterwards in case
  // another session raced us (422 just means the other one won).
  let label = await resolveLabel(client, config.markerLabel);
  if (label.error) return toolError(label.error);
  if (label.id === null) {
    const created = await createMarkerLabel(client, config.markerLabel);
    if (created.error && created.status !== 422) return toolError(created.error);
    label = await resolveLabel(client, config.markerLabel);
    if (label.error) return toolError(label.error);
    if (label.id === null) {
      return toolError(`The "${config.markerLabel}" label still cannot be found after creating it.`);
    }
  }

  const res = await client.call("POST", "/issues", {
    title,
    body: body + attribution(),
    labels: [label.id],
  });
  if (res.error) return toolError(res.error);
  if (!res.data || typeof res.data.number !== "number") {
    return toolError(`Unexpected response creating the issue (HTTP ${res.status}).`);
  }
  return textResult(`Created #${res.data.number}: ${res.data.title}\n${res.data.html_url ?? ""}`);
}

async function editIssueTool(client, args) {
  const n = toNumber(args.number);
  if (n === null) return toolError("number must be a positive integer issue number");
  const patch = {};
  const changed = [];
  if (typeof args.title === "string" && args.title.trim() !== "") {
    patch.title = args.title;
    changed.push("title");
  }
  if (typeof args.body === "string") {
    patch.body = args.body + attribution();
    changed.push("body");
  }
  if (args.state !== undefined) {
    if (args.state !== "open" && args.state !== "closed") {
      return toolError(`state must be "open" or "closed", got ${JSON.stringify(args.state)}`);
    }
    patch.state = args.state;
    changed.push("state");
  }
  if (changed.length === 0) {
    return toolError("Nothing to update: pass at least one of title, body, state.");
  }
  const { status, data, error } = await client.call("PATCH", `/issues/${n}`, patch);
  if (error) {
    return toolError(
      status === 404
        ? `Issue #${n} does not exist on ${config.host}/${TARGET.owner}/${TARGET.repo}.`
        : error
    );
  }
  return textResult(`Updated #${data.number}: ${data.title} (${changed.join(", ")})`);
}

async function addCommentTool(client, args) {
  const n = toNumber(args.number);
  if (n === null) return toolError("number must be a positive integer issue number");
  if (typeof args.body !== "string" || args.body.trim() === "") {
    return toolError("body is required");
  }
  const res = await client.call("POST", `/issues/${n}/comments`, {
    body: args.body + attribution(),
  });
  if (res.error) {
    return toolError(
      res.status === 404
        ? `Issue #${n} does not exist on ${config.host}/${TARGET.owner}/${TARGET.repo}.`
        : res.error
    );
  }
  return textResult(`Commented on #${n}.`);
}

async function setIssueStateTool(client, args) {
  const n = toNumber(args.number);
  if (n === null) return toolError("number must be a positive integer issue number");
  if (args.state !== "open" && args.state !== "closed") {
    return toolError(`state must be "open" or "closed", got ${JSON.stringify(args.state ?? null)}`);
  }
  const { status, data, error } = await client.call("PATCH", `/issues/${n}`, { state: args.state });
  if (error) {
    return toolError(
      status === 404
        ? `Issue #${n} does not exist on ${config.host}/${TARGET.owner}/${TARGET.repo}.`
        : error
    );
  }
  return textResult(`${args.state === "closed" ? "Closed" : "Reopened"} #${data.number}: ${data.title}`);
}
