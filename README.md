# Grok Build Research MCP

Read-only MCP tools for LM Studio backed by the installed Grok Build CLI.

Tools:

- `grok_x_search` — current X post and thread research
- `grok_web_research` — web research with linked sources
- `grok_read_url` — focused reading of one public URL

The wrapper exposes only Grok Build's `web_search` and `web_fetch` tools. It
runs each request in a fresh temporary directory with subagents and Grok memory
disabled, then removes that directory. It accepts two concurrent Grok Build
requests by default, so a slower X search does not block normal web research,
while still preventing unbounded CLI processes from piling up.

Optional environment values:

- `GROK_BUILD_BIN`: Grok Build executable path.
- `GROK_BUILD_MODEL`: optional model override.
- `GROK_BUILD_TIMEOUT_MS`: hard timeout for each CLI process; defaults to `120000`.
- `GROK_BUILD_MAX_CONCURRENT`: simultaneous request cap; defaults to `2` and is capped at `4`.

Authentication is inherited from the existing Grok Build CLI login.
