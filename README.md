# claude-forgejo-issues

A Claude Code plugin that treats a Forgejo (or Gitea) repo's issue tracker as the
agent's TODO store: open TODOs are injected as context at session start, and six
MCP tools let the agent list, read, create, edit, comment on, and close them.

The plugin is deliberately scoped to issues + comments. If a request would grow
it beyond that, it should be discussed before it is built -- see NOTES.md.

## How it decides to be active

Both the hook and the MCP server activate only when the current repo has a git
remote pointing at your forge host (default `git.danya02.ru`, configurable).
Any remote counts -- so a repo can keep a GitHub `origin` and a second remote
on the forge, and the plugin still works there.

Outside a forge repo the hook is silent and the MCP server does not start. No
noise, no errors, no wasted calls.

## Install

From the marketplace (after it is published):

```
/plugin marketplace add danya02/claude-forgejo-issues
/plugin install forgejo-issues
```

While developing from a local checkout:

```
/plugin marketplace add /home/danya/Projects/claude-forgejo-issues
/plugin install forgejo-issues
```

## Token setup

The plugin needs a Forgejo/Gitea API token with the **issue** scope (that
alone is enough -- the plugin never calls `/user` or repo search). Create one
at `https://<your-host>/user/settings/applications` (on the default host:
https://git.danya02.ru/user/settings/applications), then store it in one of
three places, in order of preference:

1. **Plugin options** (recommended): `/plugin`, Enter on Forgejo Issues,
   **Configure options**, paste into "Forgejo API token". Input is masked and
   the value goes to the OS secure store -- never into `settings.json`.
2. **Token file**: `~/.config/claude-forgejo-issues/token` (contents: just
   the token; `umask 077` first).
3. **Environment**: `CLAUDE_FORGEJO_ISSUES_TOKEN` (handy for one-off runs).

Precedence: plugin option > environment > file. The token is never written to
the repo, never logged, and never appears in an error message.

## Configuration

Set via the plugin's options (`/plugin`, Enter on Forgejo Issues, **Configure
options**; stored per user in `~/.claude/settings.json`, except the token,
which goes to the OS secure store) or a config file
`~/.config/claude-forgejo-issues/config.json` (per machine); plugin options
win. All values have defaults, and the option descriptions in the dialog
carry examples.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `forgejo_token` | string | *(empty)* | The API token (see Token setup). Sensitive: masked input, stored in the OS secure store. |
| `forge_host` | string | `git.danya02.ru` | Hostname of the forge. A repo activates when any remote URL points at this host. |
| `marker_label` | string | `agent-todo` | Issues carrying this label are the TODOs: injected, listed, and added to new issues. Created automatically on first `create_issue`. |
| `inject_on_prompt` | boolean | `false` | Also refresh the TODO list on every prompt, not just at session start. |
| `attribution` | boolean | `true` | Append a "Written by Claude with claude-forgejo-issues" note to issues and comments the tools create. |
| `attribution_session` | boolean | `true` | Include the Claude Code session id in that note. |
| `request_timeout_seconds` | number | `5` | Request timeout toward the forge (1-30). |
| `debug_log` | boolean | `false` | Append errors to `errors.ndjson` in the plugin data directory. |

## Tools

| Tool | Does |
| --- | --- |
| `list_issues` | One line per TODO (`#12 title [labels]`). Filtered to the marker label by default; `state` and `all` widen the view. |
| `get_issue` | Full issue: description, labels, state, comment thread. |
| `create_issue` | New TODO, tagged with the marker label automatically, attribution appended. |
| `edit_issue` | Change title, body, and/or state. |
| `add_comment` | Comment on an issue, attribution appended. |
| `set_issue_state` | Close (TODO done) or reopen. |

## Command

`/forgejo-issues:setup` -- guided setup and troubleshooting: resolves the
forge host, checks the repo's remotes against it, verifies token presence
without ever displaying the token, and walks through creation and first-use
verification.

## The hook

At session start in a forge repo the hook injects the open TODO list as
context and prints a visible line (`forgejo-issues: injected N open TODOs
from owner/repo`) so the behavior is observable. When per-prompt refresh is
enabled, a moved list re-injects the full block and an unmoved list emits a
one-liner (`TODOs unchanged (N open)`).

Errors surface once per session per distinct error, both to the model and as
a visible line. A missing token reports once and names the expected token
path. Silence in a non-forge repo is by design.

## Testing

```
node tests/run.mjs
```

40 offline tests: a local HTTP server stands in for the forge, a fake `git`
stands in for remotes, and the hook and MCP server run as real subprocesses.
Live-forge checks (run against a real instance, by hand or by an agent) are in
`tests/MANUAL.md`.

## Compatibility

Built and verified against Forgejo 16.0.5+gitea-1.22.0 (`git.danya02.ru`);
the API surface used is the Gitea-compatible `/api/v1`, so other reasonably
recent Gitea/Forgejo versions should work. Node 20+ (anything with top-level
await). No dependencies.
