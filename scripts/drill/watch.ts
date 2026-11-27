/**
 * Follows a drill's issue through the repair loop and merges the repair when
 * it passes the same checks the ruleset requires on main:
 * `node scripts/drill/watch.ts --scenario <name> --issues <n,...> --branch <drill/...>`.
 *
 * Env: GITHUB_TOKEN (the live-check App's token, which may merge),
 * GITHUB_REPOSITORY, AGENT_BOT_LOGIN. Writes a step table to
 * GITHUB_STEP_SUMMARY and exits 1 when a step fails.
 */
import { appendFileSync } from 'node:fs';
import { SCENARIOS } from './scenarios.ts';

/** The status checks the ruleset requires; a drill's repair must pass the same ones. */
export const REQUIRED_CHECKS = [
  'checks',
  'fixtures (node)',
  'fixtures (bun)',
  'fixtures (deno)',
  'fixtures (browser)',
  'path-allowlist',
  'live-check (node)',
];

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (!v) throw new Error(`missing ${name}`);
  return v;
};
const scenario = SCENARIOS[arg('--scenario')]!;
const issues = arg('--issues').split(',').filter(Boolean).map(Number);
const branch = arg('--branch');
const agentLogin = process.env.AGENT_BOT_LOGIN ?? '';
const PR_TIMEOUT_MS = 75 * 60_000;
const CHECKS_TIMEOUT_MS = 45 * 60_000;
const POLL_MS = 30_000;

const steps: { step: string; ok: boolean; detail: string; at: string }[] = [];
const started = Date.now();
function record(step: string, ok: boolean, detail: string): boolean {
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  steps.push({ step, ok, detail, at: `${minutes} min` });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
  return ok;
}

async function github(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Prints what a wait loop sees at most every 5 minutes, so a long wait shows progress in the log. */
let lastHeartbeat = 0;
function heartbeat(message: string): void {
  if (Date.now() - lastHeartbeat < 5 * 60_000) return;
  lastHeartbeat = Date.now();
  console.log(`[${((Date.now() - started) / 60_000).toFixed(1)} min] ${message}`);
}
const labelsOf = (issue: any): string[] => issue.labels.map((l: any) => (typeof l === 'string' ? l : l.name));

async function issueFor(category: string): Promise<any | null> {
  for (const n of issues) {
    const issue = await github(`/issues/${n}`);
    if (labelsOf(issue).includes(`category:${category}`)) return issue;
  }
  return null;
}

async function repairPull(issue: number): Promise<any | null> {
  const pulls = (await github(`/pulls?state=all&base=${encodeURIComponent(branch)}&per_page=50`)) as any[];
  return pulls.find((p) => p.user.login === agentLogin && new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${issue}\\b`, 'i').test(p.body ?? '')) ?? null;
}

/** Waits for every required check on the pull request's current head; null while pending. */
async function checksVerdict(pull: any): Promise<{ ok: boolean; detail: string } | null> {
  const fresh = await github(`/pulls/${pull.number}`);
  const runs = (await github(`/commits/${fresh.head.sha}/check-runs?per_page=100`)).check_runs as any[];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const name of REQUIRED_CHECKS) {
    const run = runs.filter((r) => r.name === name).sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== 'completed') missing.push(name);
    else if (run.conclusion !== 'success') failed.push(`${name} (${run.conclusion})`);
  }
  if (failed.length > 0) return { ok: false, detail: `failed: ${failed.join(', ')}` };
  if (missing.length > 0) {
    heartbeat(`checks on ${fresh.head.sha.slice(0, 7)}: waiting for ${missing.join(', ')}`);
    return null;
  }
  return { ok: true, detail: `all ${REQUIRED_CHECKS.length} required checks passed on ${fresh.head.sha.slice(0, 7)}` };
}

async function drillAgentPath(): Promise<boolean> {
  const issue = await issueFor(scenario.expect);
  if (!record('issue filed', issue !== null, issue ? `#${issue.number} with category ${scenario.expect}` : `no issue with category ${scenario.expect} among #${issues.join(', #')}`)) return false;
  if (!record('routed to the agent', labelsOf(issue).includes('agent-repair'), labelsOf(issue).join(', '))) return false;
  console.log(`waiting up to ${PR_TIMEOUT_MS / 60_000} min for a pull request by ${agentLogin || '(AGENT_BOT_LOGIN unset)'} into ${branch} that closes #${issue.number}`);

  let pull: any = null;
  for (const deadline = Date.now() + PR_TIMEOUT_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    pull = await repairPull(issue.number);
    if (pull) break;
    const now = await github(`/issues/${issue.number}`);
    if (labelsOf(now).includes('needs-maintainer')) return record('agent opened a pull request', false, 'the issue was handed to the maintainer instead');
    heartbeat(`no pull request yet; issue #${issue.number} is ${now.state} with labels ${labelsOf(now).join(', ')} and ${now.comments} comments`);
  }
  if (!record('agent opened a pull request', pull !== null, pull ? `#${pull.number} into ${branch}` : `none within ${PR_TIMEOUT_MS / 60_000} min`)) return false;
  console.log(`waiting up to ${CHECKS_TIMEOUT_MS / 60_000} min for ${REQUIRED_CHECKS.join(', ')} on ${pull.html_url}`);
  lastHeartbeat = 0;

  let verdict: { ok: boolean; detail: string } | null = null;
  for (const deadline = Date.now() + CHECKS_TIMEOUT_MS; Date.now() < deadline && !verdict; await sleep(POLL_MS)) {
    verdict = await checksVerdict(pull);
  }
  if (!record('required checks', verdict?.ok === true, verdict?.detail ?? `still pending after ${CHECKS_TIMEOUT_MS / 60_000} min`)) return false;

  const merged = await github(`/pulls/${pull.number}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash' }) }).catch((e: Error) => e);
  return record('merged into the drill branch', !(merged instanceof Error), merged instanceof Error ? merged.message : `#${pull.number}`);
}

/** The agent triages the issue and answers on it, closing it or handing it to the maintainer, without a pull request. */
async function drillNoRepairPath(): Promise<boolean> {
  const issue = await issueFor(scenario.expect);
  if (!record('issue filed', issue !== null, issue ? `#${issue.number} with category ${scenario.expect}` : `no issue with category ${scenario.expect}`)) return false;
  if (!record('routed to the agent', labelsOf(issue).includes('agent-repair'), labelsOf(issue).join(', '))) return false;
  console.log(`waiting up to ${PR_TIMEOUT_MS / 60_000} min for the agent to close #${issue.number} or add needs-maintainer`);
  let answered: any = null;
  for (const deadline = Date.now() + PR_TIMEOUT_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    const now = await github(`/issues/${issue.number}`);
    if (now.state === 'closed' || labelsOf(now).includes('needs-maintainer')) {
      answered = now;
      break;
    }
    heartbeat(`issue #${issue.number} is ${now.state} with labels ${labelsOf(now).join(', ')} and ${now.comments} comments`);
  }
  const how = answered ? (answered.state === 'closed' ? 'closed the issue' : 'handed it to the maintainer') : '';
  if (!record('agent answered on the issue', answered !== null, answered ? `${how} after ${answered.comments} comments` : `no answer within ${PR_TIMEOUT_MS / 60_000} min`)) return false;
  const pull = await repairPull(issue.number);
  return record('no pull request', pull === null, pull ? `pull request #${pull.number} was opened` : 'none opened');
}

const ok = await (scenario.outcome === 'repair' ? drillAgentPath() : drillNoRepairPath()).catch((e: Error) => record('watch', false, e.message));
const table = ['| Step | Result | Detail | At |', '|---|---|---|---|', ...steps.map((s) => `| ${s.step} | ${s.ok ? 'pass' : 'FAIL'} | ${s.detail} | ${s.at} |`)].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Repair\n\n${table}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `repaired=${ok && scenario.outcome === 'repair'}\n`);
process.exitCode = ok ? 0 : 1;
