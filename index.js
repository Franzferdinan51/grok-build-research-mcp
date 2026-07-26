#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  cancelNativeDeepJob,
  nativeDeepJobResult,
  nativeDeepJobStatus,
  startNativeDeepJob,
} from './deep-jobs.js';

const execFileAsync = promisify(execFile);
const grokBin = process.env.GROK_BUILD_BIN || 'grok';
const model = process.env.GROK_BUILD_MODEL || 'grok-build';
const searchModel = process.env.GROK_BUILD_SEARCH_MODEL || 'grok-build';
const xSearchModel = process.env.GROK_BUILD_X_SEARCH_MODEL || 'grok-4-20-non-reasoning';
const fastResearchModel = process.env.GROK_BUILD_FAST_RESEARCH_MODEL || 'grok-4-20-non-reasoning';
const timeoutMs = Number.parseInt(process.env.GROK_BUILD_TIMEOUT_MS || '90000', 10);
const maxConcurrent = Math.min(
  4,
  Math.max(1, Number.parseInt(process.env.GROK_BUILD_MAX_CONCURRENT || '2', 10)),
);
const maxDeepConcurrent = 1;
const minIntervalMs = Math.max(
  0,
  Number.parseInt(process.env.GROK_BUILD_MIN_INTERVAL_MS || '2500', 10),
);
const rateLimitWindowMs = Math.max(
  1000,
  Number.parseInt(process.env.GROK_BUILD_RATE_LIMIT_WINDOW_MS || '300000', 10),
);
const maxRateLimitUnits = Math.max(
  1,
  Number.parseInt(process.env.GROK_BUILD_RATE_LIMIT_MAX_UNITS || '12', 10),
);
const allowedModels = new Set(
  (process.env.GROK_BUILD_ALLOWED_MODELS
    || 'grok-build,grok-4.5,grok-4-20-multi-agent,grok-4-20-reasoning,grok-4-20-non-reasoning')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const maxBuffer = 8 * 1024 * 1024;
let activeRuns = 0;
let activeDeepRuns = 0;
let lastRunStartedAt = 0;
let recentRunStarts = [];

function cleanOutput(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .trim();
}

function firstJsonValue(value) {
  const text = cleanOutput(value);
  for (let start = 0; start < text.length; start += 1) {
    if (!['[', '{'].includes(text[start])) continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '[' || character === '{') {
        stack.push(character);
      } else if (character === ']' || character === '}') {
        const opening = stack.pop();
        if ((opening === '[' && character !== ']') || (opening === '{' && character !== '}')) break;
        if (!stack.length) {
          const candidate = text.slice(start, index + 1);
          try {
            return JSON.stringify(JSON.parse(candidate), null, 2);
          } catch {
            break;
          }
        }
      }
    }
  }
  return text;
}

async function runGrok(prompt, options = {}) {
  const isolatedCwd = await mkdtemp(join(tmpdir(), 'lmstudio-grok-research-'));
  const selectedModel = options.model || model;
  const maxTurns = Math.min(12, Math.max(1, options.maxTurns || 8));
  const enabledTools = options.tools === undefined ? 'web_search,web_fetch' : options.tools;
  const args = [
    '--cwd',
    isolatedCwd,
    '--single',
    prompt,
    '--always-approve',
    '--no-subagents',
    '--no-memory',
    '--max-turns',
    String(maxTurns),
    '--output-format',
    'plain',
    '--system-prompt-override',
    [
      'You are a read-only research agent.',
      'The built-in web_search and web_fetch tools are directly available when allowlisted.',
      'Call those tools directly; never call search_tool, use_tool, or any MCP integration.',
      'Follow the requested tool-call limit, then produce the final answer without additional searches.',
    ].join(' '),
  ];
  if (enabledTools) {
    args.splice(4, 0, '--tools', enabledTools);
  } else {
    args.push('--disable-web-search');
  }
  if (selectedModel) args.push('--model', selectedModel);

  try {
    const { stdout, stderr } = await execFileAsync(grokBin, args, {
      timeout: options.timeoutMs || timeoutMs,
      maxBuffer,
      env: {
        ...process.env,
        GROK_WEB_SEARCH_MODEL: options.webSearchModel
          || process.env.GROK_WEB_SEARCH_MODEL
          || searchModel,
      },
    });
    const output = cleanOutput(stdout);
    if (!output) throw new Error(cleanOutput(stderr) || 'Grok Build returned no output.');
    return options.jsonOnly ? firstJsonValue(output) : output;
  } catch (error) {
    const partialOutput = cleanOutput(error.stdout);
    if (partialOutput) {
      const usableOutput = options.jsonOnly ? firstJsonValue(partialOutput) : partialOutput;
      return `${usableOutput}\n\n[Stopped at the MCP latency limit; partial results returned instead of letting the host time out.]`;
    }
    throw error;
  } finally {
    await rm(isolatedCwd, { recursive: true, force: true });
  }
}

function optionalLine(label, value) {
  return typeof value === 'string' && value.trim() ? `${label}: ${value.trim()}` : '';
}

function requiredText(args, name) {
  const value = typeof args[name] === 'string' ? args[name].trim() : '';
  return value;
}

function publicUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:'].includes(parsed.protocol) ? trimmed : '';
  } catch {
    return '';
  }
}

function publicUrls(value, maximum = 8) {
  if (!Array.isArray(value)) return [];
  return value.map(publicUrl).filter(Boolean).slice(0, maximum);
}

function rateLimitRetryAfter(now, cost) {
  recentRunStarts = recentRunStarts.filter(
    (entry) => now - entry.startedAt < rateLimitWindowMs,
  );

  const intervalRemaining = minIntervalMs - (now - lastRunStartedAt);
  if (lastRunStartedAt && intervalRemaining > 0) return intervalRemaining;

  const unitsUsed = recentRunStarts.reduce((total, entry) => total + entry.cost, 0);
  if (unitsUsed + cost <= maxRateLimitUnits) return 0;

  let unitsToExpire = unitsUsed + cost - maxRateLimitUnits;
  for (const entry of recentRunStarts) {
    unitsToExpire -= entry.cost;
    if (unitsToExpire <= 0) {
      return Math.max(1, rateLimitWindowMs - (now - entry.startedAt));
    }
  }
  return rateLimitWindowMs;
}

function recordRunStart(now, cost) {
  lastRunStartedAt = now;
  recentRunStarts.push({ startedAt: now, cost });
}

const tools = [
  {
    name: 'grok_x_search',
    description: 'Search current X posts through Grok and return a source-linked summary. Use for breaking news, posts, threads, reactions, and X-specific research.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find or verify on X.' },
        handles: { type: 'string', description: 'Optional comma-separated X handles to prioritize.' },
        date_range: { type: 'string', description: 'Optional date or date range in plain language.' },
        max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Approximate maximum number of posts to return. Default: 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grok_web_research',
    description: 'Research a current topic with Grok web search and fetch, returning a concise answer with source links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Research question or topic.' },
        source_preferences: { type: 'string', description: 'Optional preferred sources, domains, or source types.' },
        depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'Research depth. Default: standard.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grok_read_url',
    description: 'Read and summarize one public web URL with Grok, preserving important claims and links.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public HTTP or HTTPS URL to read.' },
        focus: { type: 'string', description: 'Optional question or extraction focus.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'grok_fact_check',
    description: 'Fact-check a current claim with primary sources and clearly label what is confirmed, false, misleading, or unresolved.',
    inputSchema: {
      type: 'object',
      properties: {
        claim: { type: 'string', description: 'Claim to verify.' },
        context: { type: 'string', description: 'Optional context, source, speaker, or date.' },
        source_url: { type: 'string', description: 'Optional public URL where the claim appeared.' },
      },
      required: ['claim'],
    },
  },
  {
    name: 'grok_x_thread_reader',
    description: 'Read a public X post or thread, reconstruct its context, and summarize claims and notable reactions with direct links.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public x.com or twitter.com post URL.' },
        focus: { type: 'string', description: 'Optional question or analysis focus.' },
        include_reactions: { type: 'boolean', description: 'Include notable public reactions. Default: true.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'grok_compare_sources',
    description: 'Compare multiple public sources or competing claims, highlighting agreement, conflicts, evidence quality, and unresolved points.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question or topic the sources address.' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 8,
          description: 'Two to eight public HTTP/HTTPS URLs.',
        },
        criteria: { type: 'string', description: 'Optional comparison criteria.' },
      },
      required: ['question', 'urls'],
    },
  },
  {
    name: 'grok_news_brief',
    description: 'Produce a current, source-linked news brief with a timeline, key actors, confirmed facts, and open questions.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'News topic or event.' },
        timeframe: { type: 'string', description: 'Optional timeframe, such as last 24 hours or since July 1.' },
        region: { type: 'string', description: 'Optional geographic focus.' },
        length: { type: 'string', enum: ['short', 'standard', 'detailed'], description: 'Brief length. Default: standard.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'grok_extract_data',
    description: 'Research or read public sources and return machine-readable JSON matching the requested fields.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'What information to extract.' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 8,
          description: 'Optional public source URLs.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 30,
          description: 'Field names to include in each JSON result.',
        },
      },
      required: ['request', 'fields'],
    },
  },
  {
    name: 'grok_find_sources',
    description: 'Find high-quality sources for a topic and return direct links with brief descriptions and source-quality notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or question requiring sources.' },
        source_types: { type: 'string', description: 'Optional preferred source types or domains.' },
        max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum source count. Default: 10.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grok_quick_deep_research',
    description: 'Run the original synchronous deep-research pass. It returns during the current MCP call and is capped to fit LM Studio latency limits.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Complex research question.' },
        source_preferences: { type: 'string', description: 'Optional preferred sources or domains.' },
        deliverable: { type: 'string', description: 'Optional requested output format or decision to support.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grok_deep_research',
    description: 'Start xAI Grok Build’s native verified Deep Research as a background job and immediately return a job ID. Do not poll it in the same assistant turn; give the job ID to the user, then use the status and result tools in a later turn.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Complex research question.' },
        breadth: { type: 'integer', minimum: 2, maximum: 6, description: 'Independent research-question breadth. Default: 4.' },
        source_preferences: { type: 'string', description: 'Optional preferred sources or domains.' },
        deliverable: { type: 'string', description: 'Optional requested output format or decision to support.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'grok_deep_research_status',
    description: 'Check a native Deep Research background job. Returns its phase, workflow status, agent usage, and elapsed time immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by grok_deep_research.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'grok_deep_research_result',
    description: 'Retrieve the final native Deep Research report when ready. If still running, returns ready=false and current progress without blocking.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by grok_deep_research.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'grok_deep_research_cancel',
    description: 'Cancel a running native Deep Research background job and its Grok workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job ID returned by grok_deep_research.' },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'grok_model_query',
    description: 'Ask an approved Grok model a read-only, web-enabled question. Model choices are restricted by server configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Question or research task.' },
        model: {
          type: 'string',
          description: 'Approved model ID. Defaults to the server model or grok-build.',
        },
        max_turns: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum agent turns. Default: 6.' },
      },
      required: ['prompt'],
    },
  },
];

const server = new Server(
  { name: 'grok-build-research', version: '1.3.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  const toolName = request.params.name;
  let prompt;
  let runOptions = {};
  let isDeep = false;

  if (toolName === 'grok_deep_research') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    if (query.length > 20_000) {
      return {
        content: [{ type: 'text', text: 'query must be 20,000 characters or fewer.' }],
        isError: true,
      };
    }
    const sourcePreferences = requiredText(args, 'source_preferences');
    const deliverable = requiredText(args, 'deliverable');
    if (sourcePreferences.length > 4_000 || deliverable.length > 4_000) {
      return {
        content: [{
          type: 'text',
          text: 'source_preferences and deliverable must each be 4,000 characters or fewer.',
        }],
        isError: true,
      };
    }
    const breadth = Math.min(6, Math.max(2, Number.parseInt(args.breadth, 10) || 4));
    const nativeRateCost = Math.max(
      3,
      Number.parseInt(process.env.GROK_BUILD_NATIVE_DEEP_RATE_COST || '6', 10),
    );
    const now = Date.now();
    const retryAfterMs = rateLimitRetryAfter(now, nativeRateCost);
    if (retryAfterMs > 0) {
      return {
        content: [{
          type: 'text',
          text: `Grok Build rate protection rejected the native workflow before launch. Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`,
        }],
        isError: true,
      };
    }
    try {
      const job = await startNativeDeepJob({
        query,
        breadth,
        sourcePreferences,
        deliverable,
        model: process.env.GROK_BUILD_NATIVE_DEEP_MODEL || 'grok-build',
        grokBin,
      });
      recordRunStart(now, nativeRateCost);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...job,
            ready: false,
            next_check_after_seconds: 30,
            instruction: `Do not poll in this assistant turn. Return job_id ${job.job_id} to the user. In a later turn, call grok_deep_research_status and then grok_deep_research_result when ready.`,
          }, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Native Deep Research was not started: ${error.message}` }],
        isError: true,
      };
    }
  }

  if (toolName === 'grok_deep_research_status') {
    try {
      const job = await nativeDeepJobStatus(requiredText(args, 'job_id'));
      const ready = !['queued', 'launching', 'running', 'cancelling'].includes(job.status);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...job,
            ready,
            ...(ready ? {} : {
              next_check_after_seconds: 30,
              instruction: 'Do not poll again in this assistant turn. Report the current phase and check again only after a later user request.',
            }),
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }

  if (toolName === 'grok_deep_research_result') {
    try {
      const job = await nativeDeepJobResult(requiredText(args, 'job_id'));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...job,
            ...(job.ready ? {} : {
              next_check_after_seconds: 30,
              instruction: 'The report is not ready. Do not poll again in this assistant turn.',
            }),
          }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }

  if (toolName === 'grok_deep_research_cancel') {
    try {
      const job = await cancelNativeDeepJob(requiredText(args, 'job_id'));
      return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }

  if (toolName === 'grok_x_search') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    const maxResults = Math.min(10, Math.max(1, Number.parseInt(args.max_results, 10) || 3));
    prompt = [
      'Call web_search directly exactly once for the request below.',
      'Target site:x.com and use the indexed search results only. Do not fetch or open any result pages.',
      'Prioritize direct x.com status URLs rather than summaries or profile pages.',
      'Distinguish verified facts from claims or reactions. Include post dates, handles, and direct links whenever available.',
      `Return no more than ${maxResults} relevant X posts, followed by a concise synthesis.`,
      optionalLine('Handles to prioritize', args.handles),
      optionalLine('Date range', args.date_range),
      `Request: ${query}`,
    ].filter(Boolean).join('\n');
    runOptions = {
      model: xSearchModel,
      webSearchModel: xSearchModel,
      tools: 'web_search',
      maxTurns: 4,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_web_research') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    const depth = ['quick', 'standard', 'deep'].includes(args.depth) ? args.depth : 'standard';
    prompt = [
      `Research depth: ${depth}.`,
      'Call web_search directly once. Prefer primary sources in the returned results.',
      'Answer in plain language, separate confirmed facts from uncertainty, and include direct source links.',
      optionalLine('Preferred sources', args.source_preferences),
      `Request: ${query}`,
    ].filter(Boolean).join('\n');
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      tools: 'web_search',
      maxTurns: 3,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_read_url') {
    const url = publicUrl(args.url);
    if (!url) {
      return { content: [{ type: 'text', text: 'A public HTTP or HTTPS URL is required.' }], isError: true };
    }
    prompt = [
      `Read this public URL with web fetch: ${url}`,
      optionalLine('Focus', args.focus),
      'Summarize the page faithfully, identify the publisher and date when available, preserve important claims, and note anything that cannot be verified.',
    ].filter(Boolean).join('\n');
    runOptions = { model: searchModel, tools: 'web_fetch', maxTurns: 4, timeoutMs: 50000 };
  } else if (toolName === 'grok_fact_check') {
    const claim = requiredText(args, 'claim');
    if (!claim) return { content: [{ type: 'text', text: 'claim is required.' }], isError: true };
    const sourceUrl = args.source_url ? publicUrl(args.source_url) : '';
    if (args.source_url && !sourceUrl) {
      return { content: [{ type: 'text', text: 'source_url must be a public HTTP or HTTPS URL.' }], isError: true };
    }
    prompt = [
      'Call web_search directly once to fact-check the claim below, prioritizing primary sources.',
      'Return a verdict of Confirmed, Mostly true, Misleading, Unsupported, False, or Unresolved.',
      'Return a concise verdict with the strongest evidence, important missing context, dates, and no more than three direct source links.',
      optionalLine('Source URL', sourceUrl),
      optionalLine('Context', args.context),
      `Claim: ${claim}`,
    ].filter(Boolean).join('\n');
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      tools: 'web_search',
      maxTurns: 3,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_x_thread_reader') {
    const url = publicUrl(args.url);
    if (!url || !/^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(url)) {
      return { content: [{ type: 'text', text: 'A public x.com or twitter.com URL is required.' }], isError: true };
    }
    prompt = [
      `Read this X post and its accessible thread context: ${url}`,
      'Identify the author and date, reconstruct the thread in order, summarize its main claims, and preserve direct post links.',
      args.include_reactions === false
        ? 'Do not include public reactions.'
        : 'Include a concise sample of notable public reactions, clearly separated from verified facts.',
      optionalLine('Focus', args.focus),
      'State plainly when replies, quoted posts, or deleted content are inaccessible.',
    ].filter(Boolean).join('\n');
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      tools: 'web_fetch',
      maxTurns: 5,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_compare_sources') {
    const question = requiredText(args, 'question');
    const urls = publicUrls(args.urls);
    if (!question) return { content: [{ type: 'text', text: 'question is required.' }], isError: true };
    if (urls.length < 2 || urls.length !== args.urls.length) {
      return { content: [{ type: 'text', text: 'Two to eight valid public HTTP or HTTPS URLs are required.' }], isError: true };
    }
    prompt = [
      'Read and compare every source below.',
      `Question: ${question}`,
      optionalLine('Comparison criteria', args.criteria),
      `Sources:\n${urls.map((url, index) => `${index + 1}. ${url}`).join('\n')}`,
      'Explain agreements, contradictions, evidence quality, publication dates, possible bias, and unresolved questions. Cite direct links throughout.',
    ].filter(Boolean).join('\n');
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      tools: 'web_fetch',
      maxTurns: 6,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_news_brief') {
    const topic = requiredText(args, 'topic');
    if (!topic) return { content: [{ type: 'text', text: 'topic is required.' }], isError: true };
    const length = ['short', 'standard', 'detailed'].includes(args.length) ? args.length : 'standard';
    prompt = [
      `Call web_search directly once, then create a ${length} current news brief using primary sources where possible.`,
      `Topic: ${topic}`,
      optionalLine('Timeframe', args.timeframe),
      optionalLine('Region', args.region),
      'Include: bottom line, timestamped timeline, key actors, confirmed facts, disputed claims, what to watch next, and direct source links.',
    ].filter(Boolean).join('\n');
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      tools: 'web_search',
      maxTurns: 4,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_extract_data') {
    const extractionRequest = requiredText(args, 'request');
    const fields = Array.isArray(args.fields)
      ? args.fields.map((value) => String(value).trim()).filter(Boolean).slice(0, 30)
      : [];
    const urls = publicUrls(args.urls || []);
    if (!extractionRequest) return { content: [{ type: 'text', text: 'request is required.' }], isError: true };
    if (!fields.length) return { content: [{ type: 'text', text: 'At least one field is required.' }], isError: true };
    if (Array.isArray(args.urls) && urls.length !== args.urls.length) {
      return { content: [{ type: 'text', text: 'Every URL must be a public HTTP or HTTPS URL.' }], isError: true };
    }
    prompt = [
      'Use web search and fetch as needed, then return valid JSON only—no Markdown fences or commentary.',
      `Extraction request: ${extractionRequest}`,
      `Required fields: ${fields.join(', ')}`,
      urls.length ? `Source URLs:\n${urls.join('\n')}` : '',
      'Return a JSON array of objects. Use null for unavailable values and include a source_url field for provenance.',
    ].filter(Boolean).join('\n');
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      maxTurns: 4,
      timeoutMs: 50000,
      jsonOnly: true,
    };
  } else if (toolName === 'grok_find_sources') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    const maxResults = Math.min(20, Math.max(1, Number.parseInt(args.max_results, 10) || 10));
    prompt = [
      `Call web_search directly once and find up to ${maxResults} high-quality current sources for the request below.`,
      'Prioritize primary, official, peer-reviewed, or direct reporting sources. Avoid duplicate syndication and low-quality aggregators.',
      optionalLine('Preferred source types', args.source_types),
      `Request: ${query}`,
      'Return a numbered list containing title, publisher, date, direct URL, source type, and one sentence explaining relevance. Do not write a general essay.',
    ].filter(Boolean).join('\n');
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      tools: 'web_search',
      maxTurns: 4,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_quick_deep_research') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    prompt = [
      'Call web_search directly once, then perform an extended research synthesis from the returned evidence.',
      'Develop competing hypotheses, verify important claims against primary sources, resolve contradictions where possible, and cite direct links.',
      optionalLine('Preferred sources', args.source_preferences),
      optionalLine('Requested deliverable', args.deliverable),
      `Research question: ${query}`,
      'Return an executive summary, evidence, counterevidence, uncertainties, conclusion, and recommended next checks.',
    ].filter(Boolean).join('\n');
    isDeep = true;
    runOptions = {
      model: fastResearchModel,
      webSearchModel: fastResearchModel,
      tools: 'web_search',
      maxTurns: 5,
      timeoutMs: 50000,
    };
  } else if (toolName === 'grok_model_query') {
    const userPrompt = requiredText(args, 'prompt');
    if (!userPrompt) return { content: [{ type: 'text', text: 'prompt is required.' }], isError: true };
    const selectedModel = requiredText(args, 'model') || model || 'grok-build';
    if (!allowedModels.has(selectedModel)) {
      return {
        content: [{
          type: 'text',
          text: `Model is not approved. Allowed models: ${[...allowedModels].join(', ')}`,
        }],
        isError: true,
      };
    }
    const maxTurns = Math.min(8, Math.max(1, Number.parseInt(args.max_turns, 10) || 6));
    prompt = [
      'Answer the request directly without calling tools.',
      'Be concise and distinguish uncertainty when relevant.',
      `Request: ${userPrompt}`,
    ].join('\n');
    isDeep = selectedModel.includes('multi-agent');
    runOptions = { model: selectedModel, tools: '', maxTurns: Math.min(maxTurns, 3), timeoutMs: 50000 };
  } else {
    return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
  }

  if (activeRuns >= maxConcurrent) {
    return {
      content: [{
        type: 'text',
        text: `Grok Build research is at its ${maxConcurrent}-request concurrency limit. No additional CLI process was started; retry after one active request finishes.`,
      }],
      isError: true,
    };
  }
  if (isDeep && activeDeepRuns >= maxDeepConcurrent) {
    return {
      content: [{
        type: 'text',
        text: 'A deep or multi-agent Grok request is already running. No additional CLI process was started; retry after it finishes.',
      }],
      isError: true,
    };
  }

  const rateLimitCost = isDeep ? 3 : 1;
  const now = Date.now();
  const retryAfterMs = rateLimitRetryAfter(now, rateLimitCost);
  if (retryAfterMs > 0) {
    return {
      content: [{
        type: 'text',
        text: `Grok Build rate limit is protecting the API plan. No CLI process was started. Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`,
      }],
      isError: true,
    };
  }

  recordRunStart(now, rateLimitCost);
  activeRuns += 1;
  if (isDeep) activeDeepRuns += 1;
  try {
    return { content: [{ type: 'text', text: await runGrok(prompt, runOptions) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Grok Build research failed: ${error.message}` }], isError: true };
  } finally {
    activeRuns = Math.max(0, activeRuns - 1);
    if (isDeep) activeDeepRuns = Math.max(0, activeDeepRuns - 1);
  }
});

await server.connect(new StdioServerTransport());
