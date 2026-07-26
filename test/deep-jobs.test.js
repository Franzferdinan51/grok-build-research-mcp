import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  cancelNativeDeepJob,
  listNativeDeepWorkflows,
  nativeDeepJobResult,
  nativeDeepJobStatus,
  startNativeDeepJob,
  validJobId,
} from '../deep-jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', 'fixtures', 'fake-native-worker.js');
const launchAndExitPath = join(__dirname, '..', 'fixtures', 'launch-and-exit.js');
const execFileAsync = promisify(execFile);

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
    const dashboard = await listNativeDeepWorkflows({ directory });
    assert.equal(dashboard.length, 1);
    assert.equal(dashboard[0].ready, true);
    assert.equal(dashboard[0].result_available, true);
    assert.ok(dashboard[0].elapsed_ms > 0);
    const activeOnly = await listNativeDeepWorkflows({
      directory,
      includeCompleted: false,
    });
    assert.deepEqual(activeOnly, []);
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

test('an abruptly killed worker is interrupted and its credential workspace is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-native-interrupt-test-'));
  try {
    const started = await startNativeDeepJob({
      query: 'cancel after abrupt exit',
      directory,
      workerPath,
    });
    const running = await waitFor(started.job_id, directory, 'running');
    const isolatedCwd = join(
      tmpdir(),
      `lmstudio-native-deep-${started.job_id}-${running.worker_pid || 'test'}`,
    );
    const isolatedGrokHome = join(
      tmpdir(),
      `lmstudio-native-grok-home-${started.job_id}-${running.worker_pid || 'test'}`,
    );
    await mkdir(isolatedCwd, { recursive: true });
    await mkdir(isolatedGrokHome, { recursive: true });
    const path = join(directory, `${started.job_id}.json`);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    persisted.isolatedCwd = isolatedCwd;
    persisted.isolatedGrokHome = isolatedGrokHome;
    await writeFile(path, JSON.stringify(persisted));
    process.kill(persisted.workerPid, 'SIGKILL');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(persisted.workerPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        break;
      }
    }
    const interrupted = await nativeDeepJobStatus(started.job_id, directory);
    assert.equal(interrupted.status, 'interrupted');
    await assert.rejects(access(isolatedCwd), { code: 'ENOENT' });
    await assert.rejects(access(isolatedGrokHome), { code: 'ENOENT' });
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

test(
  'macOS launchd worker survives the process that launched it',
  { skip: process.platform !== 'darwin' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'grok-native-launchd-test-'));
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [launchAndExitPath, directory, workerPath],
      );
      const jobId = stdout.trim();
      assert.equal(validJobId(jobId), true);
      const completed = await waitFor(jobId, directory, 'completed', 5000);
      assert.equal(completed.launch_mode, 'launchd');
      assert.match(completed.current_phase, /Report/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('invalid job ids are rejected before reading the filesystem', async () => {
  await assert.rejects(nativeDeepJobStatus('../../etc/passwd'), /valid deep-research job_id/);
});
