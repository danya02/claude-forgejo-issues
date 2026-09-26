# NOTES -- design rationale

Why the plugin is the way it is. Deliberately no roadmap and no open-questions
list: future work belongs in the forge's own issues.

## The marker label is a namespace

Everything the agent handles carries the `agent-todo` label (configurable).
That is the user's decision recorded as a default: the forge's default issue
view stays human, the hook only ever injects agent TODOs, and `list_issues`
filters to them unless explicitly widened. The label is created automatically
on first `create_issue`, and `list_issues` merely *mentions* that it is
missing rather than creating it -- listing stays read-only.

## Never query with an unverified label name

Measured on Forgejo 16.0.5+gitea-1.22.0: a `labels=` filter naming an unknown
label is not an error -- the name is silently dropped from the filter and the
query returns ALL issues. A naive implementation would report "no TODOs" while
actually listing everything. So the label is resolved to a numeric id first
(`GET /labels`), and every filtered query uses the id. When the label does not
exist, "zero TODOs" is reported without querying issues at all. This order is
asserted in tests: `/labels` must be requested before `/issues`, and an absent
label must produce no `/issues` request.

## The gate: any remote, hostname-exact

The plugin activates when any git remote points at the forge host (port
ignored, `https://`, `ssh://`, and scp-like forms all parse). The reason for
"any remote" rather than "origin": repos can keep a GitHub `origin` for
publishing and a second remote on the forge for private TODOs -- the gate must
not force TODOs into the public tracker. Matching is on hostname only, so a
forge on a nonstandard port still matches. `origin` is preferred when several
remotes match, then alphabetical order keeps behavior stable.

## Attribution and the session id

Both the user and the agent commit to the same forge account, so content the
tools create carries a footer ("Written by Claude with claude-forgejo-issues")
and optionally the Claude Code session id, making agent-authored issues and
comments distinguishable. Both parts toggle independently.

The session id needs no plumbing: plugin MCP server processes inherit
`CLAUDE_CODE_SESSION_ID` (verified against live plugin servers on this
machine). It is validated against a UUID-ish shape before use, so a future
change of shape can only drop the session reference, never inject odd text
into the forge.

## The MCP gate exits at startup, and what is not yet measured

When the repo is not on the forge host, the MCP server exits 0 before the
handshake. What Claude Code then shows for that server (no tools at all vs
tools listed but failing) has not been observed yet -- it is the one open
empirical question, recorded as a live check in tests/MANUAL.md. The fallback
design is ready: keep the server alive and answer every tool call with a clean
"not a forge repo" error. That variant is worse for the common case (tools
cluttering every session) but safer if the exit turns out to be noisy.

## Issue-scoped tokens are sufficient

Verified live: every endpoint the plugin uses works with a token whose only
scope is issues. `/user` and `/repos/search` need more scope and are never
called -- repo discovery comes from `git remote -v`, not from the API. The
README can therefore honestly recommend a minimal-scope token.

## Pagination is bounded

The API's maximum page size is 50 (measured). Lists are fetched with
`limit=50` and stop after 10 pages: 500 issues is a pathological TODO store,
and hooks must stay latency-bounded. The count shown is the fetched count.
`resolveLabel` sweeps labels the same way; a repo with more than 500 labels
reports zero TODOs rather than an error -- accepted and documented here rather
than pretending it cannot happen.

## IPv4-first name resolution

Symptom, observed on this machine (2026-09): every node request to the forge
took just over 5 s -- curl answered the same URL in ~60 ms, `tls.connect` was
fast, and `dns.lookup` with Node's default (AF_UNSPEC) took ~5 s where the
same lookup pinned to AF_INET answered in ~8 ms. The forge has a single A
record and no AAAA; the stall is in the resolver path, most likely a quirk of
this network's DNS/IPv6 handling (the user suspects IPv6 is broken locally),
not of Node and not of Forgejo. Someone mirroring this elsewhere should
re-measure before assuming it applies to them.

Left alone, the stall sat just past the default 5 s request timeout: every
TODO fetch failed in the hook and every tool call would crawl. The fix is a
custom `lookup` handed to node:http that asks for AF_INET first and falls
back to AF_INET6 only when there is no A record. On healthy networks the
change is unobservable (dual-stack hosts just prefer v4, as most clients do
anyway); on this network it turns 5 s into ~50 ms; an IPv6-only forge host
still works through the fallback.

## A proxy-aware transport, by hand

Node's fetch ignores `HTTP_PROXY`/`HTTPS_PROXY` unless the process was
*started* with `NODE_USE_ENV_PROXY=1` -- a script cannot set it for itself at
runtime, and prefixing it inside a hooks.json command breaks on Windows. So
the transport (node:http/https) honors the proxy env itself: absolute-URI
requests through http proxies, CONNECT tunnels for https, `NO_PROXY` respected,
lowercase-before-uppercase precedence, unparseable proxy values mean direct.
The token rides in a header and can therefore never appear in a URL or an
error message (errors carry method + URL + route taken).

## Config precedence and the second config file

Plugin settings (userConfig, which arrives to the scripts as
`CLAUDE_PLUGIN_OPTION_*` env) > `config.json` in the same directory as the
token > defaults. The per-machine file exists so host-specific knobs (a
different forge host, a longer timeout) can live next to the per-machine
token, outside any repo. A missing or invalid config.json falls back to
defaults silently -- it is optional by design; operational failures (network,
API, token) are never silent.

The token follows the same precedence: plugin option (the "Forgejo API
token" field -- `sensitive`, so it is masked in the dialog and stored in the
OS secure store, never in settings.json) > `CLAUDE_FORGEJO_ISSUES_TOKEN` >
the token file. There is deliberately no config.json token key: the chain
stays three sources.

One asymmetry is load-bearing: `CLAUDE_PLUGIN_OPTION_*` env vars are
documented for hook processes only. MCP stdio servers receive settings only
via `${user_config.<key>}` substitution in the server's `env` map, so
`.mcp.json` maps every option to its `CLAUDE_PLUGIN_OPTION_*` name
explicitly. Before that map existed, the tools silently ran on defaults no
matter what was configured -- the hook honored settings, the MCP server did
not. What an unset option substitutes to is undocumented (empty string,
absent variable, or the literal placeholder), so `envString` treats a value
that is *exactly* a `${user_config.<key>}` placeholder as unset -- a
whole-value match, because a real value merely containing that substring
must survive.

## Scope guard

The plugin does issues and comments: list, get, create, edit, comment, close,
plus display-only labels. It does not manage labels, milestones, pulls,
releases, or wiki. If a request would grow it beyond issues + comments, the
right move is to discuss renaming or splitting the plugin rather than letting
it accrete -- its whole value is being small enough to hold in one head.
