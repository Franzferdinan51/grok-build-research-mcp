#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';

const path = process.argv[2];

async function awaitLaunchRegistration() {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const candidate = JSON.parse(await readFile(path, 'utf8'));
    if (candidate.workerPid === process.pid) return candidate;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Fake worker was not registered.');
}

let job = await awaitLaunchRegistration();

async function persist(patch) {
  job = { ...job, ...patch, updatedAt: new Date().toISOString() };
  const temporary = `${path}.fake-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(job)}\n`);
  await rename(temporary, path);
}

process.once('SIGTERM', async () => {
  await persist({
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: null,
  });
  process.exit(0);
});

await persist({
  status: 'running',
  workerPid: process.pid,
  startedAt: new Date().toISOString(),
  workflowName: 'deep-research',
  workflowRunId: 'wf_fake',
  currentPhase: 'Research',
  phases: [{ title: 'Research', state: 'active' }],
  agentsUsed: 2,
});

const completionDelay = job.query.includes('cancel')
  ? 5000
  : job.query.includes('instant')
    ? 0
    : 300;
await new Promise((resolve) => setTimeout(resolve, completionDelay));
await persist({
  status: 'completed',
  currentPhase: 'Report',
  result: '# Fake verified report\n\nComplete.',
  completedAt: new Date().toISOString(),
  agentsUsed: 6,
});
