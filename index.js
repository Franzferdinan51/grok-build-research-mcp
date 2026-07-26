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
const model = process.env.GROK_BUILD_MODEL || '';
const timeoutMs = Number.parseInt(process.env.GROK_BUILD_TIMEOUT_MS || '120000', 10);
const maxConcurrent = Math.min(
  4,
  Math.max(1, Number.parseInt(process.env.GROK_BUILD_MAX_CONCURRENT || '2', 10)),
);
const maxBuffer = 8 * 1024 * 1024;
let activeRuns = 0;

function cleanOutput(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .trim();
}

async function runGrok(prompt) {
  const isolatedCwd = await mkdtemp(join(tmpdir(), 'lmstudio-grok-research-'));
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
    '6',
    '--output-format',
    'plain',
  ];
  if (model) args.push('--model', model);

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
];

const server = new Server(
  { name: 'grok-build-research', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  let prompt;

  if (request.params.name === 'grok_x_search') {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
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
    const query = typeof args.query === 'string' ? args.query.trim() : '';
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
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) {
      return { content: [{ type: 'text', text: 'A public HTTP or HTTPS URL is required.' }], isError: true };
    }
    prompt = [
      `Read this public URL with web fetch: ${url}`,
      optionalLine('Focus', args.focus),
      'Summarize the page faithfully, identify the publisher and date when available, preserve important claims, and note anything that cannot be verified.',
    ].filter(Boolean).join('\n');
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

  activeRuns += 1;
  try {
    return { content: [{ type: 'text', text: await runGrok(prompt) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Grok Build research failed: ${error.message}` }], isError: true };
  } finally {
    activeRuns = Math.max(0, activeRuns - 1);
  }
});

await server.connect(new StdioServerTransport());
