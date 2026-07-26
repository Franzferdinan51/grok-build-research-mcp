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
- `grok_deep_research` — controlled, one-at-a-time multi-agent research
- `grok_model_query` — read-only queries through an approved model

The wrapper exposes only Grok Build's `web_search` and `web_fetch` tools. It
runs each request in a fresh temporary directory with subagents and Grok memory
disabled, then removes that directory. It accepts two concurrent Grok Build
requests by default, so a slower X search does not block normal web research,
while still preventing unbounded CLI processes from piling up. Deep and
multi-agent requests have an additional one-at-a-time guard.

All tools remain read-only. The server never enables shell commands, file
editing, persistent memory, worktrees, or unrestricted plugins.
Normal requests are capped at eight agent turns; deep research is capped at
ten turns. Every CLI process is still subject to the server's hard timeout.

Optional environment values:

- `GROK_BUILD_BIN`: Grok Build executable path.
- `GROK_BUILD_MODEL`: optional model override.
- `GROK_BUILD_TIMEOUT_MS`: hard timeout for each CLI process; defaults to `120000`.
- `GROK_BUILD_MAX_CONCURRENT`: simultaneous request cap; defaults to `2` and is capped at `4`.
- `GROK_BUILD_DEEP_MODEL`: model used by `grok_deep_research`; defaults to `grok-4-20-multi-agent`.
- `GROK_BUILD_ALLOWED_MODELS`: comma-separated allowlist for `grok_model_query`.

Authentication is inherited from the existing Grok Build CLI login.
