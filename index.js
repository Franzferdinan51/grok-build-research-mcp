#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const execFileAsync = promisify(execFile);
const grokBin = process.env.GROK_BUILD_BIN || 'grok';
const model = process.env.GROK_BUILD_MODEL || 'grok-build';
const timeoutMs = Number.parseInt(process.env.GROK_BUILD_TIMEOUT_MS || '120000', 10);
const maxConcurrent = Math.min(
  4,
  Math.max(1, Number.parseInt(process.env.GROK_BUILD_MAX_CONCURRENT || '2', 10)),
);
const maxDeepConcurrent = 1;
const defaultDeepModel = process.env.GROK_BUILD_DEEP_MODEL || 'grok-4-20-multi-agent';
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

function cleanOutput(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .trim();
}

async function runGrok(prompt, options = {}) {
  const isolatedCwd = await mkdtemp(join(tmpdir(), 'lmstudio-grok-research-'));
  const selectedModel = options.model || model;
  const maxTurns = Math.min(12, Math.max(1, options.maxTurns || 8));
  const args = [
    '--cwd',
    isolatedCwd,
    '--single',
    prompt,
    '--tools',
    'web_search,web_fetch',
    '--no-subagents',
    '--no-memory',
    '--max-turns',
    String(maxTurns),
    '--output-format',
    'plain',
  ];
  if (selectedModel) args.push('--model', selectedModel);

  try {
    const { stdout, stderr } = await execFileAsync(grokBin, args, {
      timeout: timeoutMs,
      maxBuffer,
      env: process.env,
    });
    const output = cleanOutput(stdout);
    if (!output) throw new Error(cleanOutput(stderr) || 'Grok Build returned no output.');
    return output;
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
    name: 'grok_deep_research',
    description: 'Run a slower, one-at-a-time deep research pass with Grok multi-agent reasoning, primary sources, and a structured synthesis.',
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
  { name: 'grok-build-research', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  let prompt;
  let runOptions = {};
  let isDeep = false;

  if (request.params.name === 'grok_x_search') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    const maxResults = Math.min(20, Math.max(1, Number.parseInt(args.max_results, 10) || 10));
    prompt = [
      'Research the request below with your built-in web search, prioritizing current X posts and direct x.com status URLs.',
      'Distinguish verified facts from claims or reactions. Include post dates, handles, and direct links whenever available.',
      `Return no more than ${maxResults} relevant X posts, followed by a concise synthesis.`,
      optionalLine('Handles to prioritize', args.handles),
      optionalLine('Date range', args.date_range),
      `Request: ${query}`,
    ].filter(Boolean).join('\n');
  } else if (request.params.name === 'grok_web_research') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    const depth = ['quick', 'standard', 'deep'].includes(args.depth) ? args.depth : 'standard';
    prompt = [
      `Research depth: ${depth}.`,
      'Use current web search and fetch primary sources when possible.',
      'Answer in plain language, separate confirmed facts from uncertainty, and include direct source links.',
      optionalLine('Preferred sources', args.source_preferences),
      `Request: ${query}`,
    ].filter(Boolean).join('\n');
  } else if (request.params.name === 'grok_read_url') {
    const url = publicUrl(args.url);
    if (!url) {
      return { content: [{ type: 'text', text: 'A public HTTP or HTTPS URL is required.' }], isError: true };
    }
    prompt = [
      `Read this public URL with web fetch: ${url}`,
      optionalLine('Focus', args.focus),
      'Summarize the page faithfully, identify the publisher and date when available, preserve important claims, and note anything that cannot be verified.',
    ].filter(Boolean).join('\n');
  } else if (request.params.name === 'grok_fact_check') {
    const claim = requiredText(args, 'claim');
    if (!claim) return { content: [{ type: 'text', text: 'claim is required.' }], isError: true };
    const sourceUrl = args.source_url ? publicUrl(args.source_url) : '';
    if (args.source_url && !sourceUrl) {
      return { content: [{ type: 'text', text: 'source_url must be a public HTTP or HTTPS URL.' }], isError: true };
    }
    prompt = [
      'Fact-check the claim below using current web search and primary sources whenever possible.',
      'Return a verdict of Confirmed, Mostly true, Misleading, Unsupported, False, or Unresolved.',
      'Explain the evidence, distinguish fact from inference, note important missing context, and include direct source links and dates.',
      optionalLine('Source URL', sourceUrl),
      optionalLine('Context', args.context),
      `Claim: ${claim}`,
    ].filter(Boolean).join('\n');
  } else if (request.params.name === 'grok_x_thread_reader') {
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
  } else if (request.params.name === 'grok_compare_sources') {
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
  } else if (request.params.name === 'grok_news_brief') {
    const topic = requiredText(args, 'topic');
    if (!topic) return { content: [{ type: 'text', text: 'topic is required.' }], isError: true };
    const length = ['short', 'standard', 'detailed'].includes(args.length) ? args.length : 'standard';
    prompt = [
      `Create a ${length} current news brief using web search and primary sources where possible.`,
      `Topic: ${topic}`,
      optionalLine('Timeframe', args.timeframe),
      optionalLine('Region', args.region),
      'Include: bottom line, timestamped timeline, key actors, confirmed facts, disputed claims, what to watch next, and direct source links.',
    ].filter(Boolean).join('\n');
  } else if (request.params.name === 'grok_extract_data') {
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
  } else if (request.params.name === 'grok_find_sources') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    const maxResults = Math.min(20, Math.max(1, Number.parseInt(args.max_results, 10) || 10));
    prompt = [
      `Find up to ${maxResults} high-quality current sources for the request below.`,
      'Prioritize primary, official, peer-reviewed, or direct reporting sources. Avoid duplicate syndication and low-quality aggregators.',
      optionalLine('Preferred source types', args.source_types),
      `Request: ${query}`,
      'Return a numbered list containing title, publisher, date, direct URL, source type, and one sentence explaining relevance. Do not write a general essay.',
    ].filter(Boolean).join('\n');
  } else if (request.params.name === 'grok_deep_research') {
    const query = requiredText(args, 'query');
    if (!query) return { content: [{ type: 'text', text: 'query is required.' }], isError: true };
    prompt = [
      'Perform a deep research investigation using current web search and fetch.',
      'Develop competing hypotheses, verify important claims against primary sources, resolve contradictions where possible, and cite direct links.',
      optionalLine('Preferred sources', args.source_preferences),
      optionalLine('Requested deliverable', args.deliverable),
      `Research question: ${query}`,
      'Return an executive summary, evidence, counterevidence, uncertainties, conclusion, and recommended next checks.',
    ].filter(Boolean).join('\n');
    isDeep = true;
    runOptions = { model: defaultDeepModel, maxTurns: 10 };
  } else if (request.params.name === 'grok_model_query') {
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
      'Answer the request using only read-only web search and fetch tools.',
      'Include direct source links for factual claims and distinguish uncertainty.',
      `Request: ${userPrompt}`,
    ].join('\n');
    isDeep = selectedModel.includes('multi-agent');
    runOptions = { model: selectedModel, maxTurns };
  } else {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
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
