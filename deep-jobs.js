import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultWorker = join(__dirname, 'native-deep-worker.js');
const activeStatuses = new Set(['queued', 'launching', 'running', 'cancelling']);
const terminalStatuses = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'paused',
  'budget_limited',
]);
let startInProgress = false;

export function nativeJobDirectory() {
  return process.env.GROK_BUILD_JOB_DIR
    || join(homedir(), '.grok-build-research-mcp', 'jobs');
}

export function validJobId(value) {
  return typeof value === 'string' && /^dr_[a-z0-9]+_[a-f0-9]{8}$/.test(value);
}

function jobPath(jobId, directory = nativeJobDirectory()) {
  if (!validJobId(jobId)) throw new Error('A valid deep-research job_id is required.');
  return join(directory, `${jobId}.json`);
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readNativeJob(jobId, directory = nativeJobDirectory()) {
  const path = jobPath(jobId, directory);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Deep-research job not found: ${jobId}`);
    throw error;
  }
}

async function listNativeJobs(directory = nativeJobDirectory()) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      jobs.push(JSON.parse(await readFile(join(directory, entry.name), 'utf8')));
    } catch {
      // A worker may be replacing its state file. The next read will see it.
    }
  }
  return jobs;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupJobWorkspace(job) {
  const root = resolve(tmpdir());
  const targets = [
    ['isolatedCwd', `lmstudio-native-deep-${job.jobId}-`],
    ['isolatedGrokHome', `lmstudio-native-grok-home-${job.jobId}-`],
  ];
  for (const [fieldName, expectedPrefix] of targets) {
    if (typeof job[fieldName] !== 'string') continue;
    const candidate = resolve(job[fieldName]);
    const traversal = relative(root, candidate);
    if (
      traversal.startsWith('..')
      || isAbsolute(traversal)
      || traversal.includes('/')
      || !traversal.startsWith(expectedPrefix)
    ) {
      continue;
    }
    await rm(candidate, { recursive: true, force: true });
  }
}

async function waitForExit(child) {
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  const result = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `Worker launcher exited with ${result.signal || result.code}: ${stderr.trim()}`,
    );
  }
}

async function waitForWorkerRegistration(path, launchToken, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = JSON.parse(await readFile(path, 'utf8'));
    if (candidate.launchToken !== launchToken) {
      throw new Error('Native worker registration token changed unexpectedly.');
    }
    if (
      Number.isSafeInteger(candidate.workerPid)
      && candidate.workerPid > 0
      && (processIsAlive(candidate.workerPid) || terminalStatuses.has(candidate.status))
    ) {
      return candidate;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error('Native worker did not register within five seconds.');
}

function defaultLaunchMode(workerPath) {
  if (process.env.GROK_BUILD_NATIVE_LAUNCHER) {
    return process.env.GROK_BUILD_NATIVE_LAUNCHER;
  }
  return process.platform === 'darwin' && workerPath === defaultWorker
    ? 'launchd'
    : 'detached';
}

async function launchDetachedWorker({ workerPath, path, launchToken }) {
  const child = spawn(
    process.execPath,
    [workerPath, path, launchToken],
    {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GROK_MEMORY: '0',
        GROK_WORKFLOWS: '1',
      },
    },
  );
  child.unref();
}

async function launchWithLaunchd({
  workerPath,
  path,
  launchToken,
  launchLabel,
  workerLogPath,
}) {
  await writeFile(workerLogPath, '', { mode: 0o600 });
  await chmod(workerLogPath, 0o600);
  const wrapper = [
    '"$1" "$2" "$3" "$4"',
    'code=$?',
    '/bin/launchctl remove "$5" >/dev/null 2>&1',
    'exit "$code"',
  ].join('; ');
  const child = spawn(
    '/bin/launchctl',
    [
      'submit',
      '-l',
      launchLabel,
      '-o',
      workerLogPath,
      '-e',
      workerLogPath,
      '--',
      '/bin/sh',
      '-c',
      wrapper,
      'grok-native-worker-wrapper',
      process.execPath,
      workerPath,
      path,
      launchToken,
      launchLabel,
    ],
    {
      cwd: __dirname,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        GROK_MEMORY: '0',
        GROK_WORKFLOWS: '1',
      },
    },
  );
  await waitForExit(child);
}

function publicJob(job, includeResult = false) {
  const startedMs = Date.parse(job.startedAt || '');
  const endedMs = activeStatuses.has(job.status)
    ? Date.now()
    : Date.parse(job.completedAt || '');
  const wallElapsed = Number.isFinite(startedMs) && Number.isFinite(endedMs)
    ? Math.max(0, endedMs - startedMs)
    : 0;
  const output = {
    job_id: job.jobId,
    status: job.status,
    query: job.query,
    created_at: job.createdAt,
    started_at: job.startedAt ?? null,
    updated_at: job.updatedAt,
    completed_at: job.completedAt ?? null,
    workflow_name: job.workflowName ?? null,
    workflow_run_id: job.workflowRunId ?? null,
    current_phase: job.currentPhase ?? null,
    phases: job.phases ?? [],
    agents_used: job.agentsUsed ?? 0,
    agent_budget: job.agentBudget ?? null,
    elapsed_ms: Math.max(job.elapsedMs ?? 0, wallElapsed),
    error: job.error ?? null,
    launch_mode: job.launchMode ?? null,
  };
  if (includeResult) output.result = job.result ?? null;
  return output;
}

async function fullNativeResult(job) {
  if (typeof job.result !== 'string') return job.result ?? null;
  const match = job.result.match(/_Full report:\s+(.+?)_\s*$/s);
  if (!match || !job.workflowRunId) return job.result;
  const workflowStorageDir = job.workflowStorageDir || (
    job.isolatedCwd && job.acpSessionId
      ? join(
        homedir(),
        '.grok',
        'sessions',
        encodeURIComponent(job.isolatedCwd),
        job.acpSessionId,
      )
      : null
  );
  if (!workflowStorageDir) return job.result;
  const runRoot = resolve(workflowStorageDir, 'workflows', job.workflowRunId);
  const reportedPath = match[1].trim();
  const candidate = isAbsolute(reportedPath)
    ? resolve(reportedPath)
    : resolve(runRoot, reportedPath);
  const traversal = relative(runRoot, candidate);
  if (traversal.startsWith('..') || isAbsolute(traversal)) return job.result;
  try {
    return await readFile(candidate, 'utf8');
  } catch {
    return job.result;
  }
}

export async function startNativeDeepJob({
  query,
  breadth = 4,
  sourcePreferences = '',
  deliverable = '',
  model = 'grok-build',
  grokBin = 'grok',
  directory = nativeJobDirectory(),
  workerPath = process.env.GROK_BUILD_NATIVE_WORKER || defaultWorker,
  launchMode,
  maxRuntimeMs = Number.parseInt(
    process.env.GROK_BUILD_NATIVE_MAX_RUNTIME_MS || '1800000',
    10,
  ),
} = {}) {
  if (startInProgress) {
    throw new Error('A native deep-research launch is already being prepared.');
  }
  startInProgress = true;
  try {
    await mkdir(directory, { recursive: true });
    const jobs = await listNativeJobs(directory);
    for (const job of jobs) {
      if (!activeStatuses.has(job.status)) continue;
      if (processIsAlive(job.workerPid)) {
        throw new Error(
          `Native deep research is already running as ${job.jobId}. `
          + 'Use the status or cancel tool before starting another job.',
        );
      }
      job.status = 'interrupted';
      job.error = 'The background worker stopped before reporting a terminal result.';
      job.updatedAt = new Date().toISOString();
      job.completedAt = job.updatedAt;
      await atomicWrite(jobPath(job.jobId, directory), job);
      await cleanupJobWorkspace(job);
    }

    const now = new Date().toISOString();
    const jobId = `dr_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    const path = jobPath(jobId, directory);
    const resolvedLaunchMode = launchMode || defaultLaunchMode(workerPath);
    if (!['launchd', 'detached'].includes(resolvedLaunchMode)) {
      throw new Error('GROK_BUILD_NATIVE_LAUNCHER must be launchd or detached.');
    }
    if (resolvedLaunchMode === 'launchd' && process.platform !== 'darwin') {
      throw new Error('The launchd worker mode is only available on macOS.');
    }
    const launchToken = randomBytes(16).toString('hex');
    const launchLabel = resolvedLaunchMode === 'launchd'
      ? `com.duckbot.grok-build-research.${jobId.replaceAll('_', '-')}`
      : null;
    const workerLogPath = join(directory, `${jobId}.worker.log`);
    const job = {
      schemaVersion: 1,
      jobId,
      status: 'queued',
      workflowName: 'deep-research',
      query,
      breadth,
      sourcePreferences,
      deliverable,
      model,
      grokBin,
      maxRuntimeMs,
      launchMode: resolvedLaunchMode,
      launchToken,
      launchLabel,
      workerLogPath,
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null,
    };
    await atomicWrite(path, job);

    try {
      if (resolvedLaunchMode === 'launchd') {
        await launchWithLaunchd({
          workerPath,
          path,
          launchToken,
          launchLabel,
          workerLogPath,
        });
      } else {
        await launchDetachedWorker({ workerPath, path, launchToken });
      }
      const registered = await waitForWorkerRegistration(path, launchToken);
      return publicJob(registered);
    } catch (error) {
      if (launchLabel) {
        const cleanup = spawn('/bin/launchctl', ['remove', launchLabel], {
          stdio: 'ignore',
        });
        cleanup.unref();
      }
      const failed = JSON.parse(await readFile(path, 'utf8'));
      failed.status = 'failed';
      failed.error = `Native worker launch failed: ${error.message}`;
      failed.updatedAt = new Date().toISOString();
      failed.completedAt = failed.updatedAt;
      await atomicWrite(path, failed);
      throw error;
    }
  } finally {
    startInProgress = false;
  }
}

export async function nativeDeepJobStatus(jobId, directory = nativeJobDirectory()) {
  const job = await readNativeJob(jobId, directory);
  if (activeStatuses.has(job.status) && !processIsAlive(job.workerPid)) {
    job.status = 'interrupted';
    job.error = 'The background worker is no longer running.';
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
    await atomicWrite(jobPath(jobId, directory), job);
    await cleanupJobWorkspace(job);
  }
  return publicJob(job);
}

export async function nativeDeepJobResult(jobId, directory = nativeJobDirectory()) {
  const job = await readNativeJob(jobId, directory);
  if (terminalStatuses.has(job.status)) {
    job.result = await fullNativeResult(job);
  }
  return {
    ...publicJob(job, terminalStatuses.has(job.status)),
    ready: terminalStatuses.has(job.status),
  };
}

export async function listNativeDeepWorkflows({
  directory = nativeJobDirectory(),
  includeCompleted = true,
  status = '',
  limit = 20,
} = {}) {
  const jobs = (await listNativeJobs(directory))
    .filter((job) => validJobId(job.jobId))
    .sort((left, right) => (
      Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0)
    ));
  const workflows = [];
  for (const stored of jobs) {
    let job = stored;
    if (activeStatuses.has(stored.status)) {
      await nativeDeepJobStatus(stored.jobId, directory);
      job = await readNativeJob(stored.jobId, directory);
    }
    if (!includeCompleted && !activeStatuses.has(job.status)) continue;
    if (status && job.status !== status) continue;
    workflows.push({
      ...publicJob(job),
      ready: terminalStatuses.has(job.status),
      result_available: terminalStatuses.has(job.status) && job.result != null,
    });
    if (workflows.length >= Math.min(100, Math.max(1, limit))) break;
  }
  return workflows;
}

export async function cancelNativeDeepJob(jobId, directory = nativeJobDirectory()) {
  const job = await readNativeJob(jobId, directory);
  if (terminalStatuses.has(job.status)) return publicJob(job);

  if (processIsAlive(job.workerPid)) {
    process.kill(job.workerPid, 'SIGTERM');
    // The worker owns persistent state while it is alive. Avoid racing one of
    // its final progress/result writes; its SIGTERM handler records cancelled.
    job.status = 'cancelling';
    job.updatedAt = new Date().toISOString();
    return publicJob(job);
  }

  // The worker may have reached a terminal state between our first read and
  // liveness check, so refresh before recording a fallback cancellation.
  const latest = await readNativeJob(jobId, directory);
  if (terminalStatuses.has(latest.status)) return publicJob(latest);
  latest.status = 'cancelled';
  latest.error = null;
  latest.completedAt = new Date().toISOString();
  latest.updatedAt = latest.completedAt;
  await atomicWrite(jobPath(jobId, directory), latest);
  await cleanupJobWorkspace(latest);
  return publicJob(latest);
}

export const nativeJobInternals = {
  activeStatuses,
  terminalStatuses,
  publicJob,
};
