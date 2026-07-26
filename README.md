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
- `grok_workflows` — non-blocking active/history workflow dashboard
- `grok_quick_deep_research` — synchronous deep synthesis capped for LM Studio
- `grok_deep_research` — start xAI's native verified background workflow
- `grok_deep_research_status` — non-blocking phase and agent-usage status
- `grok_deep_research_result` — retrieve the persistent final report
- `grok_deep_research_cancel` — stop a native workflow safely
- `grok_model_query` — read-only queries through an approved model

The quick research wrapper exposes only Grok Build CLI's `web_search` and
`web_fetch` tools.
Tool-free model queries and lightweight URL/data work default to the economical
`grok-build` model alias. Search-heavy tools use the faster
`grok-4-20-non-reasoning` route so they stay inside MCP clients' common
60-second deadline. A read-only system override tells Grok to call built-in web tools
directly instead of burning turns on MCP tool discovery. These routes are
covered by live tests. It
runs each request in a fresh temporary directory with subagents and Grok memory
disabled, then removes that directory. It accepts two concurrent Grok Build
requests by default, so a slower X search does not block normal web research,
while still preventing unbounded CLI processes from piling up. Quick deep
requests have an additional one-at-a-time guard.

All tools remain read-only. The server never enables shell commands, file
editing, persistent memory, worktrees, or unrestricted plugins.
Normal requests are capped at eight agent turns; quick deep research stays
inside the MCP hard timeout.
The headless CLI is launched with automatic approval only for the explicitly
allowlisted read-only web tools, preventing invisible permission prompts from
stalling LM Studio calls.
X research uses targeted `site:x.com` web searches and direct status URLs. The
CLI's native `x_search` path is intentionally not enabled because it can stall
until the process timeout in the current Grok Build release.

## Native asynchronous Deep Research

`grok_deep_research` launches Grok Build's official `deep-research` workflow
through ACP and returns a persistent job ID immediately. The native workflow
plans independent questions, researches them in parallel, verifies candidate
claims on separate shards, validates citations, and writes a final report.

Each job runs in a detached worker rather than inside the original MCP request.
LM Studio therefore never holds a tool call open while research runs. The
status, result, and cancel tools only read or update small local job-state
files, so they return quickly and continue working after a chat change or MCP
restart. Only one native workflow is admitted at a time.

Typical flow:

1. Call `grok_deep_research` and save its `job_id`.
2. End that assistant turn instead of polling. Call
   `grok_deep_research_status` in a later turn for progress.
3. Call `grok_deep_research_result` when the status is terminal.
4. Call `grok_deep_research_cancel` if the work is no longer needed.

`grok_workflows` is the headless MCP equivalent of Grok Build's interactive
`/workflows` dashboard. It lists active and retained workflow runs without
opening a TUI or waiting for them to finish. Each ready row includes the
`job_id` LM Studio should pass to `grok_deep_research_result`.

xAI currently ships one built-in workflow, `deep-research`. Custom Rhai
workflows found under `.grok/workflows` or `~/.grok/workflows` are intentionally
not inherited or executed by this read-only research MCP: a custom workflow can
request capabilities outside web research. Additional native workflows can be
added to the allowlist after their scripts receive the same read-only review.

The older bounded behavior remains available as
`grok_quick_deep_research` for callers that need the report in the current MCP
response.

The native worker gets a temporary Grok home containing only a mode-`0600`
copy of the existing authentication file. It does not inherit normal Grok MCP
servers, plugins, hooks, or memory; its CLI sandbox and child-agent capability
mode remain read-only. The temporary home and session directory are removed
after completion, failure, or cancellation.

The server also protects the xAI plan with two API-rate controls:

- A minimum delay between request starts (2.5 seconds by default).
- A rolling five-minute budget of 12 request units. Normal calls cost one unit;
  quick deep and multi-agent calls cost three; a native Deep Research launch
  costs six units.

Rate-limited calls fail immediately with a retry-after message and do not spawn
a Grok CLI process.

Optional environment values:

- `GROK_BUILD_BIN`: Grok Build executable path.
- `GROK_BUILD_MODEL`: tool-free model-query default; defaults to `grok-build`.
- `GROK_BUILD_SEARCH_MODEL`: search-backed agent model; defaults to `grok-build`.
- `GROK_BUILD_X_SEARCH_MODEL`: latency-sensitive X-search model; defaults to `grok-4-20-non-reasoning`.
- `GROK_BUILD_FAST_RESEARCH_MODEL`: model for other deadline-sensitive research tools; defaults to `grok-4-20-non-reasoning`.
- `GROK_WEB_SEARCH_MODEL`: Grok CLI's default server-side web-search model; set to `grok-build` in the LM Studio configuration and overridden by the dedicated X-search route.
- `GROK_BUILD_TIMEOUT_MS`: hard timeout for each CLI process; defaults to `90000`.
- `GROK_BUILD_MAX_CONCURRENT`: simultaneous request cap; defaults to `2` and is capped at `4`.
- `GROK_BUILD_MIN_INTERVAL_MS`: minimum delay between request starts; defaults to `2500`.
- `GROK_BUILD_RATE_LIMIT_WINDOW_MS`: rolling budget window; defaults to `300000`.
- `GROK_BUILD_RATE_LIMIT_MAX_UNITS`: units available per window; defaults to `12`.
- `GROK_BUILD_NATIVE_DEEP_MODEL`: parent model used by native Deep Research; defaults to `grok-build`.
- `GROK_BUILD_NATIVE_DEEP_RATE_COST`: request units charged for a native workflow; defaults to `6`.
- `GROK_BUILD_NATIVE_MAX_RUNTIME_MS`: native workflow ceiling; defaults to 30 minutes.
- `GROK_BUILD_JOB_DIR`: persistent job-state directory; defaults to `~/.grok-build-research-mcp/jobs`.
- `GROK_BUILD_ALLOWED_MODELS`: comma-separated allowlist for `grok_model_query`.

Authentication is inherited from the existing Grok Build CLI login.
