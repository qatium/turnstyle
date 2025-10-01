import { debug, warning } from '@actions/core';
import { Octokit } from '@octokit/rest';
import { Endpoints } from '@octokit/types';

export class OctokitGitHub {
  private readonly octokit: Octokit;
  constructor(githubToken: string) {
    Octokit.plugin(require('@octokit/plugin-throttling'));
    this.octokit = new Octokit({
      baseUrl: process.env['GITHUB_API_URL'] || 'https://api.github.com',
      auth: githubToken,
      throttle: {
        onRateLimit: (retryAfter, options) => {
          warning(`Request quota exhausted for request ${options.method} ${options.url}`);

          if (options.request.retryCount === 0) {
            // only retries once
            debug(`Retrying after ${retryAfter} seconds!`);
            return true;
          }
        },
        onAbuseLimit: (retryAfter, options) => {
          // does not retry, only logs a warning
          debug(`Abuse detected for request ${options.method} ${options.url}`);
        },
      },
    });
  }

  workflows = async (owner: string, repo: string) => {
    debug(`🔍 API Call: GET /repos/${owner}/${repo}/actions/workflows`);
    const workflows = await this.octokit.paginate(this.octokit.actions.listRepoWorkflows, {
      owner,
      repo,
      per_page: 100,
    });
    debug(`📋 API Response: Found ${workflows.length} workflows`);
    debug(`📋 Workflows details: ${JSON.stringify(workflows.map(w => ({ id: w.id, name: w.name, state: w.state })), null, 2)}`);
    return workflows;
  };

  runs = async (owner: string, repo: string, branch: string | undefined, workflow_id: number) => {
    const options: Endpoints['GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs']['parameters'] =
    {
      owner,
      repo,
      workflow_id,
      per_page: 100,
    };

    if (branch) {
      options.branch = branch;
    }

    debug(`🔍 API Call: GET /repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs`);
    debug(`🔍 Request options: ${JSON.stringify({ ...options, branch: branch || 'all branches' }, null, 2)}`);

    const in_progress_options = {
      ...options,
      status: 'in_progress' as const,
    };
    const queued_options = {
      ...options,
      status: 'queued' as const,
    };
    const waiting_options = {
      ...options,
      status: 'waiting' as const,
    };

    debug(`🔍 Making 3 parallel API calls for statuses: in_progress, queued, waiting`);

    const in_progress_runs = this.octokit.paginate(
      this.octokit.actions.listWorkflowRuns,
      in_progress_options,
    );

    const queued_runs = this.octokit.paginate(
      this.octokit.actions.listWorkflowRuns,
      queued_options,
    );

    const waiting_runs = this.octokit.paginate(
      this.octokit.actions.listWorkflowRuns,
      waiting_options,
    );

    const [inProgressResults, queuedResults, waitingResults] = await Promise.all([in_progress_runs, queued_runs, waiting_runs]);

    debug(`📋 API Response - in_progress runs: ${inProgressResults.length}`);
    debug(`📋 API Response - queued runs: ${queuedResults.length}`);
    debug(`📋 API Response - waiting runs: ${waitingResults.length}`);

    const allRuns = [inProgressResults, queuedResults, waitingResults].flat();
    debug(`📋 Total runs found: ${allRuns.length}`);

    // Log detailed info about each run
    allRuns.forEach((run, index) => {
      debug(`📋 Run ${index + 1}: ID=${run.id}, status="${run.status}", conclusion="${run.conclusion}", created_at="${run.created_at}", branch="${run.head_branch}"`);
    });

    return allRuns;
  };

  jobs = async (owner: string, repo: string, run_id: number) => {
    const options: Endpoints['GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs']['parameters'] =
    {
      owner,
      repo,
      run_id,
      per_page: 100,
    };

    debug(`🔍 API Call: GET /repos/${owner}/${repo}/actions/runs/${run_id}/jobs`);
    const jobs = await this.octokit.paginate(this.octokit.actions.listJobsForWorkflowRun, options);
    debug(`📋 API Response: Found ${jobs.length} jobs for run ${run_id}`);

    // Log detailed info about each job
    jobs.forEach((job, index) => {
      debug(`📋 Job ${index + 1}: ID=${job.id}, name="${job.name}", status="${job.status}", conclusion="${job.conclusion}", started_at="${job.started_at}"`);
    });

    return jobs;
  };

  steps = async (owner: string, repo: string, job_id: number) => {
    const options: Endpoints['GET /repos/{owner}/{repo}/actions/jobs/{job_id}']['parameters'] = {
      owner,
      repo,
      job_id,
    };

    debug(`🔍 API Call: GET /repos/${owner}/${repo}/actions/jobs/${job_id}`);
    const { data: job } = await this.octokit.actions.getJobForWorkflowRun(options);
    const steps = job.steps || [];
    debug(`📋 API Response: Found ${steps.length} steps for job ${job_id}`);

    // Log detailed info about each step
    steps.forEach((step, index) => {
      debug(`📋 Step ${index + 1}: name="${step.name}", status="${step.status}", conclusion="${step.conclusion}", started_at="${step.started_at}"`);
    });

    return steps;
  };
}
