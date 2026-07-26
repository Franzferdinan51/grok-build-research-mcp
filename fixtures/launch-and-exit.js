#!/usr/bin/env node
import { startNativeDeepJob } from '../deep-jobs.js';

const [directory, workerPath] = process.argv.slice(2);
if (!directory || !workerPath) {
  throw new Error('launch-and-exit requires a job directory and worker path.');
}

const job = await startNativeDeepJob({
  query: 'survive the launching process',
  directory,
  workerPath,
  launchMode: 'launchd',
});
process.stdout.write(`${job.job_id}\n`);
