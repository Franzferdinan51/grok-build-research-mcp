import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  cancelNativeDeepJob,
  nativeDeepJobResult,
  nativeDeepJobStatus,
  startNativeDeepJob,
  validJobId,
} from '../deep-jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', 'fixtures', 'fake-native-worker.js');

async function waitFor(jobId, directory, expected, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await nativeDeepJobStatus(jobId, directory);
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('native jobs persist progress and results outside an MCP request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-native-job-test-'));
  try {
    const started = await startNativeDeepJob({
      query: 'test query',
      directory,
      workerPath,
    });
    assert.equal(validJobId(started.job_id), true);
    await assert.rejects(
      startNativeDeepJob({ query: 'second query', directory, workerPath }),
      /already running/,
    );
    const completed = await waitFor(started.job_id, directory, 'completed');
    assert.equal(completed.agents_used, 6);
    const workflowStorageDir = join(directory, 'session-storage');
    const reportDirectory = join(
      workflowStorageDir,
      'workflows',
      'wf_fake',
      'scratch',
    );
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'report.md'), '# Full persisted report\n');
    const path = join(directory, `${started.job_id}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    persisted.workflowStorageDir = workflowStorageDir;
    persisted.result = 'Summary\n\n_Full report: scratch/report.md_';
    await writeFile(path, JSON.stringify(persisted));
    const result = await nativeDeepJobResult(started.job_id, directory);
    assert.equal(result.ready, true);
    assert.match(result.result, /Full persisted report/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native jobs can be cancelled by job id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-native-cancel-test-'));
  try {
    const started = await startNativeDeepJob({
      query: 'cancel this job',
      directory,
      workerPath,
    });
    await waitFor(started.job_id, directory, 'running');
    const cancelling = await cancelNativeDeepJob(started.job_id, directory);
    assert.equal(cancelling.status, 'cancelling');
    const cancelled = await waitFor(started.job_id, directory, 'cancelled');
    assert.equal(cancelled.status, 'cancelled');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a fast worker result is not overwritten by launcher registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-native-race-test-'));
  try {
    const started = await startNativeDeepJob({
      query: 'instant result',
      directory,
      workerPath,
    });
    const completed = await waitFor(started.job_id, directory, 'completed');
    assert.match(completed.current_phase, /Report/);
    const result = await nativeDeepJobResult(started.job_id, directory);
    assert.match(result.result, /Fake verified report/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid job ids are rejected before reading the filesystem', async () => {
  await assert.rejects(nativeDeepJobStatus('../../etc/passwd'), /valid deep-research job_id/);
});
