import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let directory;
let client;
let transport;

test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grok-mcp-test-'));
  const fakeGrok = join(directory, 'grok');
  await writeFile(fakeGrok, `#!/bin/sh
sleep 0.1
model=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--model" ]; then model="$argument"; break; fi
  previous="$argument"
done
printf 'fake grok response; model=%s\\n' "$model"
`);
  await chmod(fakeGrok, 0o755);

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'index.js')],
    env: {
      ...process.env,
      GROK_BUILD_BIN: fakeGrok,
      GROK_BUILD_TIMEOUT_MS: '5000',
      GROK_BUILD_MIN_INTERVAL_MS: '0',
      GROK_BUILD_RATE_LIMIT_MAX_UNITS: '100',
    },
  });
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

test('lists the complete read-only research tool set', async () => {
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'grok_x_search',
    'grok_web_research',
    'grok_read_url',
    'grok_fact_check',
    'grok_x_thread_reader',
    'grok_compare_sources',
    'grok_news_brief',
    'grok_extract_data',
    'grok_find_sources',
    'grok_quick_deep_research',
    'grok_deep_research',
    'grok_deep_research_status',
    'grok_deep_research_result',
    'grok_deep_research_cancel',
    'grok_model_query',
  ]);
});

test('runs each new tool through the isolated Grok wrapper', async () => {
  const calls = [
    ['grok_fact_check', { claim: 'The sky is blue.' }],
    ['grok_x_thread_reader', { url: 'https://x.com/example/status/1' }],
    ['grok_compare_sources', { question: 'Compare', urls: ['https://example.com/a', 'https://example.com/b'] }],
    ['grok_news_brief', { topic: 'Example news' }],
    ['grok_extract_data', { request: 'Extract examples', fields: ['name'] }],
    ['grok_find_sources', { query: 'Example sources' }],
    ['grok_quick_deep_research', { query: 'Research examples deeply' }],
    ['grok_model_query', { prompt: 'Research examples', model: 'grok-build' }],
  ];

  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name} returned an error`);
    assert.match(result.content[0].text, /fake grok response/);
  }
});

test('rejects invalid URLs and unapproved models before spawning Grok', async () => {
  const badUrl = await client.callTool({
    name: 'grok_x_thread_reader',
    arguments: { url: 'file:///etc/passwd' },
  });
  assert.equal(badUrl.isError, true);

  const badModel = await client.callTool({
    name: 'grok_model_query',
    arguments: { prompt: 'hello', model: 'unapproved-model' },
  });
  assert.equal(badModel.isError, true);
  assert.match(badModel.content[0].text, /not approved/);
});

test('routes X search to the fast model and tool-free queries to Grok Build', async () => {
  const search = await client.callTool({
    name: 'grok_x_search',
    arguments: { query: 'routing test' },
  });
  assert.match(search.content[0].text, /model=grok-4-20-non-reasoning/);

  const query = await client.callTool({
    name: 'grok_model_query',
    arguments: { prompt: 'routing test' },
  });
  assert.match(query.content[0].text, /model=grok-build/);
});

test('allows only one deep or multi-agent request at a time', async () => {
  const first = client.callTool({
    name: 'grok_quick_deep_research',
    arguments: { query: 'first deep request' },
  });
  const second = client.callTool({
    name: 'grok_quick_deep_research',
    arguments: { query: 'second deep request' },
  });

  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.isError === true).length, 1);
  assert.match(
    results.find((result) => result.isError === true).content[0].text,
    /already running/,
  );
});

test('rate-limits excess requests without spawning Grok', async () => {
  const limitedTransport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'index.js')],
    env: {
      ...process.env,
      GROK_BUILD_BIN: join(directory, 'grok'),
      GROK_BUILD_TIMEOUT_MS: '5000',
      GROK_BUILD_MIN_INTERVAL_MS: '0',
      GROK_BUILD_RATE_LIMIT_WINDOW_MS: '60000',
      GROK_BUILD_RATE_LIMIT_MAX_UNITS: '2',
    },
  });
  const limitedClient = new Client({ name: 'rate-limit-client', version: '1.0.0' });
  await limitedClient.connect(limitedTransport);
  try {
    await limitedClient.callTool({ name: 'grok_web_research', arguments: { query: 'one' } });
    await limitedClient.callTool({ name: 'grok_web_research', arguments: { query: 'two' } });
    const third = await limitedClient.callTool({
      name: 'grok_web_research',
      arguments: { query: 'three' },
    });
    assert.equal(third.isError, true);
    assert.match(third.content[0].text, /protecting the API plan/);
    assert.match(third.content[0].text, /Retry after/);
  } finally {
    await limitedClient.close();
  }
});
