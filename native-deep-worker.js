#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Writable, Readable } from 'node:stream';
import process from 'node:process';
import * as acp from '@agentclientprotocol/sdk';

const jobPath = process.argv[2];
if (!jobPath) throw new Error('native-deep-worker requires a job-state path.');
const launchToken = process.argv[3];
if (!launchToken) throw new Error('native-deep-worker requires a launch token.');

async function awaitLaunchRegistration() {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const candidate = JSON.parse(await readFile(jobPath, 'utf8'));
    if (candidate.launchToken !== launchToken) {
      throw new Error('The native deep-research launch token did not match.');
    }
    if (
      candidate.status === 'queued'
      || (
        candidate.status === 'launching'
        && (!candidate.workerPid || candidate.workerPid === process.pid)
      )
    ) {
      candidate.workerPid = process.pid;
      candidate.status = 'launching';
      candidate.updatedAt = new Date().toISOString();
      const temporary = `${jobPath}.register-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, jobPath);
      return candidate;
    }
    if (candidate.workerPid === process.pid) return candidate;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error('The native deep-research worker was not registered by its launcher.');
}

let job = await awaitLaunchRegistration();
let grokProcess;
let connection;
let session;
let workflowTerminal;
let workflowTerminalResolve;
let workflowTerminalReject;
let shuttingDown = false;
let writeChain = Promise.resolve();
const workflowTerminalPromise = new Promise((resolve, reject) => {
  workflowTerminalResolve = resolve;
  workflowTerminalReject = reject;
});

function timestamp() {
  return new Date().toISOString();
}

async function logDiagnostic(event, detail = '') {
  if (!job.workerLogPath) return;
  try {
    await appendFile(
      job.workerLogPath,
      `${timestamp()} ${event}${detail ? ` ${detail}` : ''}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics must never break the research workflow.
  }
}

function atomicPersist() {
  const snapshot = structuredClone(job);
  writeChain = writeChain.then(async () => {
    const temporary = `${jobPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, jobPath);
  });
  return writeChain;
}

async function updateJob(patch) {
  Object.assign(job, patch, { updatedAt: timestamp() });
  await atomicPersist();
}

function field(update, snake, camel) {
  return update?.[snake] ?? update?.[camel];
}

async function readFullReport(summary, runId) {
  if (typeof summary !== 'string') return summary || '';
  const match = summary.match(/_Full report:\s+(.+?)_\s*$/s);
  if (!match || !job.workflowStorageDir || !runId) return summary;
  const runRoot = resolve(job.workflowStorageDir, 'workflows', runId);
  const reportedPath = match[1].trim();
  const candidate = isAbsolute(reportedPath)
    ? resolve(reportedPath)
    : resolve(runRoot, reportedPath);
  const traversal = relative(runRoot, candidate);
  if (traversal.startsWith('..') || isAbsolute(traversal)) return summary;
  try {
    return await readFile(candidate, 'utf8');
  } catch {
    return summary;
  }
}

async function handleWorkflowNotification(params) {
  if (!params || params.sessionId !== session?.sessionId) return;
  const update = params.update;
  if (!update || update.sessionUpdate !== 'workflow_updated') return;
  const objective = field(update, 'objective', 'objective') || '';
  const runId = field(update, 'run_id', 'runId');
  if (job.workflowRunId && runId !== job.workflowRunId) return;
  if (!job.workflowRunId && objective && objective !== job.query) return;

  const rawStatus = field(update, 'status', 'status') || 'active';
  const statusMap = {
    active: 'running',
    complete: 'completed',
    failed: 'failed',
    interrupted: 'interrupted',
    cancelled: 'cancelled',
    user_paused: 'paused',
    backoff_paused: 'paused',
    verification_paused: 'paused',
    budget_limited: 'budget_limited',
  };
  const mappedStatus = statusMap[rawStatus] || rawStatus;
  const patch = {
    status: mappedStatus,
    workflowRunId: runId || job.workflowRunId,
    workflowName: field(update, 'name', 'name') || job.workflowName,
    currentPhase: field(update, 'current_phase', 'currentPhase') || null,
    phases: field(update, 'phases', 'phases') || [],
    agentsUsed: field(update, 'agents_used', 'agentsUsed') || 0,
    agentBudget: field(update, 'agent_budget', 'agentBudget') ?? null,
    elapsedMs: field(update, 'elapsed_ms', 'elapsedMs') || 0,
  };
  const terminal = ['completed', 'failed', 'interrupted', 'cancelled', 'paused', 'budget_limited']
    .includes(mappedStatus);
  if (terminal) {
    const summary = field(update, 'result_summary', 'resultSummary');
    if (mappedStatus === 'completed') patch.result = await readFullReport(summary, runId);
    patch.error = mappedStatus === 'completed'
      ? null
      : field(update, 'pause_message', 'pauseMessage')
        || field(update, 'last_event_detail', 'lastEventDetail')
        || `Native workflow ended with status: ${mappedStatus}`;
    patch.completedAt = timestamp();
  }
  await updateJob(patch);
  if (terminal && !workflowTerminal) {
    workflowTerminal = patch;
    workflowTerminalResolve(patch);
  }
}

async function pollPersistedWorkflowState() {
  const workflowRoot = join(job.workflowStorageDir, 'workflows');
  while (!workflowTerminal && !shuttingDown) {
    try {
      const entries = await readdir(workflowRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const envelope = JSON.parse(
          await readFile(join(workflowRoot, entry.name, 'state.json'), 'utf8'),
        );
        const state = envelope.state;
        if (!state || state.name !== 'deep-research') continue;
        await handleWorkflowNotification({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'workflow_updated',
            ...state,
          },
        });
        break;
      }
    } catch {
      // The session or workflow directory may not exist during startup.
    }
    if (!workflowTerminal && !shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function selectPermission(params) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const option = options.find((item) => /allow/i.test(item.kind || item.name))
    || options[0];
  if (!option) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

async function stopProcesses() {
  try {
    session?.dispose();
  } catch {
    // Best-effort cleanup.
  }
  try {
    connection?.close();
  } catch {
    // Best-effort cleanup.
  }
  if (grokProcess && grokProcess.exitCode === null) {
    const exited = new Promise((resolveExit) => {
      grokProcess.once('exit', resolveExit);
    });
    grokProcess.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((resolveWait) => setTimeout(resolveWait, 3000)),
    ]);
    if (grokProcess.exitCode === null) {
      grokProcess.kill('SIGKILL');
      await Promise.race([
        exited,
        new Promise((resolveWait) => setTimeout(resolveWait, 1000)),
      ]);
    }
  }
}

async function cancelWorkflow() {
  if (shuttingDown) return;
  shuttingDown = true;
  const terminalStatuses = new Set([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'paused',
    'budget_limited',
  ]);
  if (workflowTerminal || terminalStatuses.has(job.status)) {
    await logDiagnostic('worker-stopping', `terminal-status=${job.status}`);
    await stopProcesses();
    if (job.isolatedCwd) await rm(job.isolatedCwd, { recursive: true, force: true });
    if (job.isolatedGrokHome) {
      await rm(job.isolatedGrokHome, { recursive: true, force: true });
    }
    process.exit(0);
  }
  await updateJob({ status: 'cancelling' });
  try {
    if (session && job.workflowName) {
      await Promise.race([
        session.prompt(`/workflow stop ${job.workflowName}`),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  } catch {
    // Process termination below is the hard cancellation fallback.
  }
  await updateJob({
    status: 'cancelled',
    error: null,
    completedAt: timestamp(),
  });
  await logDiagnostic('worker-cancelled');
  await stopProcesses();
  if (job.isolatedCwd) {
    await rm(job.isolatedCwd, { recursive: true, force: true });
  }
  if (job.isolatedGrokHome) {
    await rm(job.isolatedGrokHome, { recursive: true, force: true });
  }
  process.exit(0);
}

process.once('SIGTERM', () => void cancelWorkflow());
process.once('SIGINT', () => void cancelWorkflow());

async function main() {
  await logDiagnostic(
    'worker-started',
    `pid=${process.pid} launch-mode=${job.launchMode || 'unknown'}`,
  );
  const isolatedCwd = join(
    tmpdir(),
    `lmstudio-native-deep-${job.jobId}-${process.pid}`,
  );
  const isolatedGrokHome = join(
    tmpdir(),
    `lmstudio-native-grok-home-${job.jobId}-${process.pid}`,
  );
  await mkdir(isolatedCwd, { recursive: true });
  await mkdir(isolatedGrokHome, { recursive: true });
  const sourceGrokHome = process.env.GROK_HOME || join(homedir(), '.grok');
  await copyFile(join(sourceGrokHome, 'auth.json'), join(isolatedGrokHome, 'auth.json'));
  await chmod(join(isolatedGrokHome, 'auth.json'), 0o600);
  await updateJob({
    status: 'launching',
    workerPid: process.pid,
    startedAt: timestamp(),
    isolatedCwd,
    isolatedGrokHome,
  });

  grokProcess = spawn(
    job.grokBin || 'grok',
    [
      '--sandbox',
      'read-only',
      'agent',
      '--always-approve',
      '--no-leader',
      '--model',
      job.model || 'grok-build',
      'stdio',
    ],
    {
      cwd: isolatedCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GROK_HOME: isolatedGrokHome,
        GROK_MEMORY: '0',
        GROK_WORKFLOWS: '1',
        GROK_CLAUDE_MCPS_ENABLED: '0',
        GROK_CURSOR_MCPS_ENABLED: '0',
      },
    },
  );
  let stderr = '';
  grokProcess.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16000);
  });
  grokProcess.once('exit', (code, signal) => {
    void logDiagnostic(
      'grok-acp-exited',
      `code=${code ?? 'none'} signal=${signal || 'none'}`,
    );
    if (!workflowTerminal && !shuttingDown) {
      workflowTerminalReject(
        new Error(`Grok ACP process exited before completion (${signal || code}). ${stderr.trim()}`),
      );
    }
  });

  const stream = acp.ndJsonStream(
    Writable.toWeb(grokProcess.stdin),
    Readable.toWeb(grokProcess.stdout),
  );
  const app = acp
    .client({ name: 'grok-build-research-mcp-native-worker' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
      selectPermission(params))
    .onNotification(
      'x.ai/session_notification',
      (params) => params,
      ({ params }) => handleWorkflowNotification(params),
    )
    .onNotification(
      'x.ai/session/update',
      (params) => params,
      ({ params }) => handleWorkflowNotification(params),
    )
    .onNotification(
      '_x.ai/session/update',
      (params) => params,
      ({ params }) => handleWorkflowNotification(params),
    );
  connection = app.connect(stream);
  const context = connection.agent;
  await context.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  session = await context.buildSession(isolatedCwd).start();
  const workflowStorageDir = join(
    isolatedGrokHome,
    'sessions',
    encodeURIComponent(isolatedCwd),
    session.sessionId,
  );
  await updateJob({
    acpSessionId: session.sessionId,
    workflowStorageDir,
  });

  const workflowArgs = {
    query: job.query,
    objective: job.query,
    breadth: Math.min(6, Math.max(2, Number(job.breadth) || 4)),
  };
  if (job.sourcePreferences) workflowArgs.source_preferences = job.sourcePreferences;
  if (job.deliverable) workflowArgs.deliverable = job.deliverable;
  const launchText = await (async () => {
    const promptPromise = session.prompt(
      `/workflow deep-research ${JSON.stringify(workflowArgs)}`,
    );
    let text = '';
    for (;;) {
      const event = await session.nextUpdate();
      if (event.kind === 'stop') break;
      if (
        event.update.sessionUpdate === 'agent_message_chunk'
        && event.update.content?.type === 'text'
      ) {
        text += event.update.content.text;
      }
    }
    await promptPromise;
    return text.trim();
  })();
  if (!/started in the background/i.test(launchText)) {
    throw new Error(`Grok did not confirm a native workflow launch: ${launchText || 'no response'}`);
  }
  await updateJob({ status: 'running', launchMessage: launchText });
  const stateMonitor = pollPersistedWorkflowState();

  const maxRuntimeMs = Math.min(
    6 * 60 * 60 * 1000,
    Math.max(60_000, Number(job.maxRuntimeMs) || 1_800_000),
  );
  const runtimeTimeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Native deep research exceeded its maximum runtime.')),
      maxRuntimeMs,
    );
    timer.unref();
  });
  await Promise.race([
    workflowTerminalPromise,
    runtimeTimeout,
  ]);
  await logDiagnostic('workflow-terminal', `status=${job.status}`);
  await stateMonitor;
  await writeChain;
  await stopProcesses();
  await rm(isolatedCwd, { recursive: true, force: true });
  await rm(isolatedGrokHome, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  await logDiagnostic('worker-error', error.stack || error.message);
  if (!shuttingDown) {
    await updateJob({
      status: 'failed',
      error: error.message,
      completedAt: timestamp(),
    });
  }
  await stopProcesses();
  if (job.isolatedCwd) await rm(job.isolatedCwd, { recursive: true, force: true });
  if (job.isolatedGrokHome) {
    await rm(job.isolatedGrokHome, { recursive: true, force: true });
  }
  process.exitCode = 1;
}
