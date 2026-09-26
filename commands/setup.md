---
description: Set up or troubleshoot the Forgejo Issues plugin for this repo (forge host, API token, verification)
---

Walk the user through setting up (or fixing) the Forgejo Issues plugin for the current repository.

**Hard rule: never read, display, echo, or copy the API token at any step.** If the user offers to paste the token into the chat, redirect them to the options dialog or the token file instead — chat text lands in the session transcript.

## 1. Forge host

The host is `$ARGUMENTS` if the user gave one; otherwise `forge_host` from `~/.config/claude-forgejo-issues/config.json`; otherwise the default `git.danya02.ru`.

Run `git remote -v` in the current repo and compare hostnames. Explain the gate: the plugin activates in a repo when **any** remote URL points at the forge host — a repo can keep a GitHub `origin` and a second remote on the forge. Report which remotes match and which do not.

## 2. Is a token already there?

Check, without printing anything:

- File (advisory): `test -s "${XDG_CONFIG_HOME:-$HOME/.config}/claude-forgejo-issues/token" && echo present`
- Environment (advisory): `[ -n "${CLAUDE_FORGEJO_ISSUES_TOKEN:-}" ] && echo present`

Then the authoritative check: in a forge repo, call the `fj` MCP tool `list_issues`. The plugin's own settings are not visible to commands — the tool's clean error is the ground truth, and it never contains the token.

## 3. No token yet

1. Point the user to `https://<host>/user/settings/applications` to create a token with only the **issue** scope (the plugin never calls `/user` or repo search, so no more scope is needed).
2. Recommended: the user enters it via `/plugin`, Enter on Forgejo Issues, **Configure options** — masked input, stored in the OS secure store, never in `settings.json`.
3. Alternative: the user writes the token file in their own terminal (`umask 077` first, create the directory if needed):
   `printf %s 'TOKEN' > "${XDG_CONFIG_HOME:-$HOME/.config}/claude-forgejo-issues/token"`

## 4. Verify

Call `list_issues` again (or start a new session in the repo and read the `forgejo-issues: injected ...` line):

| Result | Meaning |
| --- | --- |
| TODO list (or "none open") | Working. |
| The marker label "does not exist yet" | Token works; the label is created on first `create_issue`. |
| "No Forgejo API token found" | No token reached the plugin — redo step 2, then 3. |
| HTTP 401 / 403 | Token wrong or missing the issue scope. |
| No `fj` tools at all | Wrong host or no matching remote — back to step 1. |

A token added mid-session is picked up on the next tool call (it is read per call). Changes to the other options (host, label) bind at process start: restart Claude Code after changing them.
