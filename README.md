# Grok Build Research MCP

Read-only MCP tools for LM Studio backed by the installed Grok Build CLI.

## Tools

- `grok_x_search` — current X post and thread research
- `grok_web_research` — web research with linked sources
- `grok_read_url` — focused reading of one public URL
- `grok_fact_check` — evidence-backed claim verification
- `grok_x_thread_reader` — X post/thread context and reactions
- `grok_compare_sources` — agreement, conflict, and evidence comparison
- `grok_news_brief` — source-linked current-event briefings
- `grok_extract_data` — structured JSON extraction
- `grok_find_sources` — focused primary-source discovery
- `grok_deep_research` — controlled, one-at-a-time extended research
- `grok_model_query` — read-only queries through an approved model

The wrapper exposes only Grok Build CLI's `web_search` and `web_fetch` tools.
Normal, deep, and tool-free model queries default to the economical
`grok-build` model alias. X search alone uses the faster
`grok-4-20-non-reasoning` route so it stays inside MCP clients' common 60-second
deadline. A read-only system override tells Grok to call built-in web tools
directly instead of burning turns on MCP tool discovery. These routes are
covered by live tests. It
runs each request in a fresh temporary directory with subagents and Grok memory
disabled, then removes that directory. It accepts two concurrent Grok Build
requests by default, so a slower X search does not block normal web research,
while still preventing unbounded CLI processes from piling up. Deep requests
have an additional one-at-a-time guard.

All tools remain read-only. The server never enables shell commands, file
editing, persistent memory, worktrees, or unrestricted plugins.
Normal requests are capped at eight agent turns; deep research is capped at
ten turns. Every CLI process is still subject to the server's hard timeout.
The headless CLI is launched with automatic approval only for the explicitly
allowlisted read-only web tools, preventing invisible permission prompts from
stalling LM Studio calls.
X research uses targeted `site:x.com` web searches and direct status URLs. The
CLI's native `x_search` path is intentionally not enabled because it can stall
until the process timeout in the current Grok Build release.

The server also protects the xAI plan with two API-rate controls:

- A minimum delay between request starts (2.5 seconds by default).
- A rolling five-minute budget of 12 request units. Normal calls cost one unit;
  deep and multi-agent calls cost three.

Rate-limited calls fail immediately with a retry-after message and do not spawn
a Grok CLI process.

Optional environment values:

- `GROK_BUILD_BIN`: Grok Build executable path.
- `GROK_BUILD_MODEL`: tool-free model-query default; defaults to `grok-build`.
- `GROK_BUILD_SEARCH_MODEL`: search-backed agent model; defaults to `grok-build`.
- `GROK_BUILD_X_SEARCH_MODEL`: latency-sensitive X-search model; defaults to `grok-4-20-non-reasoning`.
- `GROK_WEB_SEARCH_MODEL`: Grok CLI's default server-side web-search model; set to `grok-build` in the LM Studio configuration and overridden by the dedicated X-search route.
- `GROK_BUILD_TIMEOUT_MS`: hard timeout for each CLI process; defaults to `90000`.
- `GROK_BUILD_MAX_CONCURRENT`: simultaneous request cap; defaults to `2` and is capped at `4`.
- `GROK_BUILD_MIN_INTERVAL_MS`: minimum delay between request starts; defaults to `2500`.
- `GROK_BUILD_RATE_LIMIT_WINDOW_MS`: rolling budget window; defaults to `300000`.
- `GROK_BUILD_RATE_LIMIT_MAX_UNITS`: units available per window; defaults to `12`.
- `GROK_BUILD_DEEP_MODEL`: model used by `grok_deep_research`; defaults to `grok-build`.
- `GROK_BUILD_ALLOWED_MODELS`: comma-separated allowlist for `grok_model_query`.

Authentication is inherited from the existing Grok Build CLI login.
