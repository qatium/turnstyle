import { setOutput } from '@actions/core';
import { OctokitGitHub as GitHub } from './github';
import { Input } from './input';

export interface Wait {
  wait(secondsSoFar?: number): Promise<number>;
}

export class Waiter implements Wait {
  private readonly info: (msg: string) => void;
  private readonly debug: (msg: string) => void;
  private input: Input;
  private githubClient: GitHub;
  private readonly workflowId: any;
  private attempt: number;

  constructor(
    workflowId: any,
    githubClient: GitHub,
    input: Input,
    info: (msg: string) => void,
    debug: (msg: string) => void,
  ) {
    this.workflowId = workflowId;
    this.input = input;
    this.githubClient = githubClient;
    this.info = info;
    this.debug = debug;
    this.attempt = 0;
  }

  wait = async (secondsSoFar?: number) => {
    let pollingInterval = this.input.pollIntervalSeconds;

    // Log timing information on first call
    if (!secondsSoFar || secondsSoFar === 0) {
      const startTime = new Date().toISOString();
      console.log(`⏱️ [${startTime}] Starting turnstyle wait for run ID: ${this.input.runId}`);
    }

    if (this.input.continueAfterSeconds && (secondsSoFar || 0) >= this.input.continueAfterSeconds) {
      this.info(`🤙Exceeded wait seconds. Continuing...`);
      setOutput('force_continued', '1');
      return secondsSoFar || 0;
    }

    if (this.input.abortAfterSeconds && (secondsSoFar || 0) >= this.input.abortAfterSeconds) {
      this.info(`🛑Exceeded wait seconds. Aborting...`);
      setOutput('force_continued', '');
      throw new Error(`Aborted after waiting ${secondsSoFar} seconds`);
    }

    const fetchTime = new Date().toISOString();
    console.log(`🔍 [${fetchTime}] Fetching workflow runs for workflow ID: ${this.workflowId}`);
    const runs = await this.githubClient.runs(
      this.input.owner,
      this.input.repo,
      this.input.sameBranchOnly ? this.input.branch : undefined,
      this.workflowId,
    );
    const responseTime = new Date().toISOString();
    console.log(`📋 [${responseTime}] Received response with ${runs.length} runs`);

    console.log(`📋 Found ${runs.length} runs for workflow ${this.workflowId}`);
    console.log(`🔍 Current run ID: ${this.input.runId}`);
    console.log(
      `🔍 Branch filter: ${this.input.sameBranchOnly ? this.input.branch : 'all branches'}`,
    );

    // Log ALL runs to detect timing issues
    if (runs.length > 0) {
      console.log(`📊 ALL runs returned by API (for race condition analysis):`);
      runs.forEach((run) => {
        const comparison =
          run.id < this.input.runId
            ? '⬅️ BEFORE current'
            : run.id > this.input.runId
              ? '➡️ AFTER current'
              : '🔄 IS current';
        console.log(
          `   ${comparison} | ID=${run.id}, status="${run.status}", conclusion="${run.conclusion}", created_at="${run.created_at}"`,
        );
      });
    }

    const queueName = this.input.queueName;
    let filteredRuns = runs;

    if (queueName) {
      this.info(`Filtering runs for queue name: ${queueName}`);
      filteredRuns = runs.filter((run) => {
        const matchesQueue =
          run.display_title?.includes(queueName) || run.name?.includes(queueName);

        if (matchesQueue) {
          console.log(`✅ Run ${run.id} matches queue name: ${queueName}`);
        } else {
          console.log(
            `❌ Run ${run.id} does NOT match queue name: ${queueName} (display_title: "${run.display_title}", name: "${run.name}")`,
          );
        }

        return matchesQueue;
      });

      console.log(`After queue filtering: ${filteredRuns.length} runs match queue "${queueName}"`);
    }

    // Filter runs that started before current run
    const runsBeforeCurrent = filteredRuns.filter((run) => run.id < this.input.runId);
    console.log(`🔍 Runs before current (ID < ${this.input.runId}): ${runsBeforeCurrent.length}`);

    runsBeforeCurrent.forEach((run) => {
      const runCreatedAt = new Date(run.created_at);
      const currentTime = new Date();
      const ageSeconds = Math.floor((currentTime.getTime() - runCreatedAt.getTime()) / 1000);
      console.log(
        `🔍 Run ${run.id}: status="${run.status}", conclusion="${run.conclusion}", created_at="${run.created_at}", age=${ageSeconds}s`,
      );
    });

    const previousRuns = runsBeforeCurrent
      .filter((run) => {
        const isSuccessful: boolean = run.conclusion === 'success';

        if (isSuccessful) {
          console.log(
            `✅ Skipping successful run ${run.id}, status: ${run.status}, conclusion: ${run.conclusion}`,
          );
        } else {
          console.log(
            `⏳ Will wait for run ${run.id}, status: ${run.status}, conclusion: ${run.conclusion}`,
          );
        }

        return !isSuccessful;
      })
      .sort((a, b) => b.id - a.id);

    console.log(`🔍 Final previousRuns to wait for: ${previousRuns.length}`);
    if (!previousRuns || !previousRuns.length) {
      setOutput('force_continued', '');
      const decisionTime = new Date().toISOString();
      if (
        this.input.initialWaitSeconds > 0 &&
        (secondsSoFar || 0) < this.input.initialWaitSeconds
      ) {
        console.log(
          `⏳ [${decisionTime}] No previous runs found, but will retry due to initial-wait-seconds=${this.input.initialWaitSeconds}`,
        );
        this.info(
          `🔎 Waiting for ${this.input.initialWaitSeconds} seconds before checking for runs again...`,
        );
        await new Promise((resolve) => setTimeout(resolve, this.input.initialWaitSeconds * 1000));
        return this.wait((secondsSoFar || 0) + this.input.initialWaitSeconds);
      }
      console.log(`✅ [${decisionTime}] No previous runs to wait for - proceeding with deployment`);
      console.log(
        `📊 DECISION: Allowing run ${this.input.runId} to proceed (found ${runs.length} total runs, ${runsBeforeCurrent.length} before current, 0 need waiting)`,
      );
      return;
    } else {
      console.log(`📋 Found ${previousRuns.length} previous runs`);
    }

    const previousRun = previousRuns[0];
    // Handle if we are checking for a specific job / step to wait for
    if (this.input.jobToWaitFor) {
      console.log(`🔍 Fetching jobs for run ${previousRun.id}`);
      const jobs = await this.githubClient.jobs(this.input.owner, this.input.repo, previousRun.id);
      const job = jobs.find((job) => job.name === this.input.jobToWaitFor);
      // Now handle if we are checking for a specific step
      if (this.input.stepToWaitFor && job) {
        console.log(`🔍 Fetching steps for job ${job.id}`);
        const steps = await this.githubClient.steps(this.input.owner, this.input.repo, job.id);
        const step = steps.find((step) => step.name === this.input.stepToWaitFor);
        if (step && step.status !== 'completed') {
          this.info(`✋Awaiting step completion from job ${job.html_url} ...`);
          let pollingInterval = this.input.pollIntervalSeconds;
          if (this.input.exponentialBackoffRetries) {
            pollingInterval = this.input.pollIntervalSeconds * (2 * this.attempt || 1);
            this.info(`🔁 Attempt ${this.attempt + 1}, next will be in ${pollingInterval} seconds`);
            this.attempt++;
          }
          return this.pollAndWait(secondsSoFar, pollingInterval);
        } else if (step) {
          this.info(`Step ${this.input.stepToWaitFor} completed from run ${previousRun.html_url}`);
          return;
        } else {
          this.info(
            `Step ${this.input.stepToWaitFor} not found in job ${job.id}, awaiting full run for safety`,
          );
        }
      }

      if (job && job.status !== 'completed') {
        this.info(`✋Awaiting job run completion from job ${job.html_url} ...`);
        let pollingInterval = this.input.pollIntervalSeconds;
        if (this.input.exponentialBackoffRetries) {
          pollingInterval = this.input.pollIntervalSeconds * (2 * this.attempt || 1);
          this.info(`🔁 Attempt ${this.attempt + 1}, next will be in ${pollingInterval} seconds`);
          this.attempt++;
        }
        return this.pollAndWait(secondsSoFar, pollingInterval);
      } else if (job) {
        this.info(`Job ${this.input.jobToWaitFor} completed from run ${previousRun.html_url}`);
        return;
      } else {
        this.info(
          `Job ${this.input.jobToWaitFor} not found in run ${previousRun.id}, awaiting full run for safety`,
        );
      }
    }

    this.info(`✋Awaiting run ${previousRun.html_url} ...`);

    if (this.input.exponentialBackoffRetries) {
      pollingInterval = this.input.pollIntervalSeconds * (2 * this.attempt || 1);
      this.info(`🔁 Attempt ${this.attempt + 1}, next will be in ${pollingInterval} seconds`);
      this.attempt++;
    }

    return this.pollAndWait(secondsSoFar, pollingInterval);
  };

  pollAndWait = async (secondsSoFar?: number, pollingInterval?: number) => {
    const intervalToUse = pollingInterval || this.input.pollIntervalSeconds;
    await new Promise((resolve) => setTimeout(resolve, intervalToUse * 1000));
    return this.wait((secondsSoFar || 0) + intervalToUse);
  };
}
