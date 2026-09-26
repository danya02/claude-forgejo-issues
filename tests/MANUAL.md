# Manual checks against the live forge

Offline tests (`node tests/run.mjs`) prove the logic against a stand-in
server; these checks prove the integration with the real thing. Run them
after install, after any change, and specifically after bumping the version --
Claude Code caches installed plugins per version, so a changed plugin with an
unchanged version can keep running old code until it is reinstalled.

Setup used here: forge `git.danya02.ru` (Forgejo 16.0.5+gitea-1.22.0), test
repo `danya/ci-demo`, an issues-only token at
`~/.config/claude-forgejo-issues/token`.

## 0. Load the plugin from the checkout

```
/plugin marketplace add /home/danya/Projects/claude-forgejo-issues
/plugin install forgejo-issues
```

Restart Claude Code afterwards (hooks and MCP servers bind at session start).
After any source change: bump `version` in `.claude-plugin/plugin.json`, then
`/plugin uninstall forgejo-issues` + install again, then restart.

## 1. Session start in a forge repo

In a clone with a remote on the forge (ci-demo works; adding the forge as a
second remote to any repo also works -- the gate is any-remote):

- Expect a visible line: `forgejo-issues: injected N open TODOs from
  danya/ci-demo`.
- Expect the context to contain one line per open `agent-todo` issue.

## 2. Silence in a non-forge repo

Open a session in a repo with no remote on the forge (e.g. a GitHub-only
repo):

- Expect no TODO block, no user-visible line, no errors, and no `fj` MCP
  server.

## 3. MCP tools present in a forge repo

`/mcp` should list `fj` with six tools. Use them against ci-demo:

- `list_issues` returns the open TODOs, one line each.
- `get_issue` on one of them shows body + comments.
- `create_issue` with a title, then check on the forge web UI: the issue is
  in `danya/ci-demo`, carries the `agent-todo` label, and its body ends with
  the attribution footer including the session id.
- `edit_issue` (retitle), `add_comment`, `set_issue_state` closed, then open
  again; verify each on the UI.

## 4. MCP server in a non-forge repo: record what happens

Open a session in a non-forge repo and check `/mcp`. **This is the open
empirical question**: does a server that exits during startup show up as (a)
not listed at all, or (b) listed but failing?

- If (a): the design stands as is.
- If (b): switch to the fallback described in NOTES.md ("The MCP gate exits
  at startup...") -- keep the server alive and answer every tool call with a
  clean "not a forge repo" error.

## 5. Per-prompt refresh (opt-in)

Set `inject_on_prompt: true` in the plugin settings, restart, and in a forge
repo:

- First prompt: full block.
- Second prompt with nothing changed: `forgejo-issues: TODOs unchanged (N
  open)`.
- Create or close an issue out-of-band (web UI), third prompt: full block
  again.
- Turn it back off afterwards; the hook should then do nothing on prompts.

## 6. Missing token

Temporarily rename the token file, start a session in a forge repo:

- Exactly one visible error naming `~/.config/claude-forgejo-issues/token`
  (and nothing on the second prompt, if per-prompt refresh is on).
- Restore the token file; a NEW session should work again. Within the same
  session, a recovery can re-trigger reporting by design.

## 7. Fresh repo with no marker label

In a forge repo whose tracker has no `agent-todo` label:

- Session start: silence (zero TODOs is not an error, and never a name-based
  filtered query).
- First `create_issue` auto-creates the label with color `#7c3aed` and the
  description "Agent TODO store (claude-forgejo-issues)".

## 8. Wrong forge host

Set `forge_host` to something that matches no remote (`example.com`) and
restart:

- Every repo behaves like a non-forge repo (checks 2 and 4).
- Restore afterwards.

## 9. Secret hygiene

With `debug_log: true`, provoke an error (e.g. check 6), then grep the plugin
data directory (`errors.ndjson`) and any visible output for the token value:

- The token must not appear anywhere. Errors carry method, URL, and route,
  never the Authorization header.
