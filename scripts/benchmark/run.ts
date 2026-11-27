/**
 * Benchmarks one machine: runs the live check (scripts/live-check/check.ts) on
 * the candidate implementation and, if given, on a base, then a stress stage
 * that fetches reviews for a few hundred listings as fast as the
 * implementation's pace allows, so Airbnb's real rate limit is met. Each side
 * is measured from the client's trace. The same command runs locally and on
 * each runner of the Benchmark workflow.
 *
 *   pnpm benchmark [--candidate <dir|git ref>] [--base <dir|git ref>] [--label <name>]
 *                  [--order candidate-first|base-first] [--out <dir>] [--stress candidate|base|none]
 *
 * --candidate  default: this working tree, uncommitted changes included.
 * --base       optional; a git ref is checked out into a temporary worktree.
 *              Without it the result has no speed ratio.
 * --order      which runs first; the workflow alternates it across runners so
 *              neither side always gets the fresher IP address.
 * --out        default .benchmark. Writes benchmark.json, summary.md, and per
 *              side <side>.trace.ndjson, <side>.stress.trace.ndjson,
 *              <side>.log.txt and <side>.report.json.
 * --stress     which side gets the stress stage: candidate (default), base,
 *              or none. Only one side a machine: Airbnb's API throttle
 *              outlasts a burst by more than a minute, so a second side's
 *              stress stage would start inside the first one's. The workflow
 *              alternates the side across runners.
 *
 * The workload, the checks and the measurement come from this checkout; only
 * the library under test comes from --candidate and --base. Exit code 1 when
 * the candidate does not complete: its live check fails or its stress stage
 * ends early.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ErrorCategory } from '../../src/errors.ts';
import type { TraceEvent } from '../../src/types.ts';
import { loadContract } from '../live-check/contract.ts';
import { type Library, liveCheck } from '../live-check/check.ts';
import { type MachineResult, type StressResult, armMetrics, loadBenchmarkContract, machineSummary, stressMetrics } from './lib.ts';

const root = resolve(new URL('../../', import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const contract = loadBenchmarkContract();
const outDir = resolve(flag('--out') ?? '.benchmark');
const label = flag('--label') ?? 'local';
const order = flag('--order') ?? 'candidate-first';
if (order !== 'candidate-first' && order !== 'base-first') throw new Error('--order must be candidate-first or base-first');
/** Time between the two sides, so the second does not start in the first one's wake. */
const PAUSE_MS = 20_000;

const cleanups: (() => void)[] = [];

/** A directory holding the implementation: as given, or a git ref checked out into a temporary worktree. */
function checkout(source: string): { dir: string; commit: string | null } {
  const asDir = resolve(source);
  if (existsSync(join(asDir, 'src', 'entry-native.ts'))) {
    let commit: string | null = null;
    try {
      commit = execFileSync('git', ['-C', asDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const dirty = execFileSync('git', ['-C', asDir, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim();
      if (dirty) commit += '+uncommitted';
    } catch {
      // Not a git checkout: the directory alone names it.
    }
    return { dir: asDir, commit };
  }
  const dir = mkdtempSync(join(tmpdir(), 'airbnb-dlp-bench-'));
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', dir, source], { stdio: 'ignore' });
  cleanups.push(() => {
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' });
  });
  // The same dependencies as this checkout; a change that needs new ones is not benchmarkable here.
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, commit };
}

async function load(dir: string): Promise<Library> {
  const entry = await import(pathToFileURL(join(dir, 'src', 'entry-native.ts')).href);
  const transport = await import(pathToFileURL(join(dir, 'src', 'transport', 'impit.ts')).href);
  return { createClient: entry.createClient, bookableStays: entry.bookableStays, impitTransport: transport.impitTransport };
}

const stressSide = flag('--stress') ?? 'candidate';
if (!['candidate', 'base', 'none'].includes(stressSide)) throw new Error('--stress must be candidate, base or none');

/**
 * Searches the stress area for `listings` ids, then fetches all their reviews
 * through one client, at whatever pace it chooses. A fresh client, so the
 * pace starts from the implementation's initial rate.
 */
async function stress(lib: Library, side: string): Promise<{ events: TraceEvent[]; result: StressResult }> {
  const { area: areaId, nightlyPrice, listings, reviewsLimit } = contract.stress;
  const area = loadContract().areas.find((a) => a.id === areaId);
  if (!area) throw new Error(`contract/benchmark.json names an unknown area: ${areaId}`);
  const events: TraceEvent[] = [];
  const client = lib.createClient({ trace: (e) => events.push(e) });
  const started = Date.now();
  const ids: string[] = [];
  const search = client.search([{ area: { bbox: area.bbox }, nightlyPrice }]);
  for await (const hit of search.items()) {
    ids.push(hit.listing.id);
    if (ids.length >= listings) break;
  }
  // Leaving the loop early aborts the search on purpose; anything else that ended it counts.
  const searchError = (await search.outcome()).error;
  const { items, outcome } = await client.reviews(ids, { limit: reviewsLimit }).all();
  const ms = Date.now() - started;
  const error: ErrorCategory | null =
    (searchError && searchError.category !== 'Aborted' ? searchError.category : null) ?? outcome.error?.category ?? (ids.length < listings ? 'Unknown' : null);
  if (ids.length < listings) console.log(`[${side}] stress: the search found ${ids.length} of ${listings} listings`);
  const result = stressMetrics(events, { ms, items: items.length, ok: items.filter((r) => r.ok).length, error });
  console.log(
    `[${side}] stress: ${result.requests} requests in ${(ms / 1000).toFixed(1)} s (${result.requestsPerSecond.toFixed(1)}/s), ` +
      `${result.rateLimits} rate limits, ${result.refusals} refused, fastest pace ${result.fastestPace?.toFixed(1) ?? '–'}/s, ` +
      `${result.ok} of ${result.items} reviews, ${error ?? 'finished'}`,
  );
  return { events, result };
}

interface LiveRun {
  side: 'candidate' | 'base';
  source: string;
  commit: string | null;
  lib: Library;
  events: TraceEvent[];
  report: Awaited<ReturnType<typeof liveCheck>>['report'];
  wallMs: number;
}

/** One side's live check: correctness, and the time the speed ratio compares. */
async function live(side: 'candidate' | 'base', source: string): Promise<LiveRun> {
  const { dir, commit } = checkout(source);
  const lib = await load(dir);
  const events: TraceEvent[] = [];
  console.log(`\n== ${side}: ${source}${commit ? ` (${commit.slice(0, 12)})` : ''}`);
  const started = Date.now();
  const { report, log } = await liveCheck({
    lib,
    small: contract.small,
    history: [],
    trace: (e) => events.push(e),
    print: (line) => console.log(`[${side}] ${line}`),
  });
  const wallMs = Date.now() - started;
  writeFileSync(join(outDir, `${side}.trace.ndjson`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(outDir, `${side}.log.txt`), `${log.join('\n')}\n`);
  writeFileSync(join(outDir, `${side}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
  return { side, source, commit, lib, events, report, wallMs };
}


try {
  mkdirSync(outDir, { recursive: true });
  const candidateSource = flag('--candidate') ?? '.';
  const baseSource = flag('--base');
  const sides: ('candidate' | 'base')[] = baseSource ? (order === 'base-first' ? ['base', 'candidate'] : ['candidate', 'base']) : ['candidate'];
  const runs: LiveRun[] = [];
  for (const [i, side] of sides.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    runs.push(await live(side, side === 'candidate' ? candidateSource : baseSource!));
  }
  // After both live checks, so neither starts inside the throttle a stress stage provokes.
  const stressBySide = new Map<'candidate' | 'base', StressResult>();
  const stressed = runs.find((r) => r.side === stressSide);
  if (stressed) {
    const { events, result } = await stress(stressed.lib, stressed.side);
    stressBySide.set(stressed.side, result);
    writeFileSync(join(outDir, `${stressed.side}.stress.trace.ndjson`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  const arm = (run: LiveRun | undefined) =>
    run ? armMetrics(run.events, run.report, { source: run.source, commit: run.commit, wallMs: run.wallMs }, stressBySide.get(run.side) ?? null) : null;
  const candidate = arm(runs.find((r) => r.side === 'candidate'))!;
  const base = arm(runs.find((r) => r.side === 'base'));
  const machine: MachineResult = {
    version: 1,
    label,
    candidate,
    base,
    // The live checks' times: both ran before either stress stage.
    speedRatio: base && base.completed && candidate.completed ? base.wallMs / candidate.wallMs : null,
  };
  writeFileSync(join(outDir, 'benchmark.json'), `${JSON.stringify(machine, null, 2)}\n`);
  const summary = machineSummary(machine);
  writeFileSync(join(outDir, 'summary.md'), summary);
  console.log(`\n${summary}`);
  console.log(`Wrote ${join(outDir, 'benchmark.json')} and ${join(outDir, 'summary.md')}.`);
  process.exitCode = candidate.completed ? 0 : 1;
} finally {
  for (const cleanup of cleanups) cleanup();
}
