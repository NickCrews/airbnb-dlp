/**
 * Benchmarks one machine: runs the live check (scripts/live-check/check.ts) on
 * the candidate implementation and, if given, on a base, and measures each
 * from the client's trace. The same command runs locally and on each runner of
 * the Benchmark workflow.
 *
 *   pnpm benchmark [--candidate <dir|git ref>] [--base <dir|git ref>] [--label <name>]
 *                  [--order candidate-first|base-first] [--out <dir>]
 *
 * --candidate  default: this working tree, uncommitted changes included.
 * --base       optional; a git ref is checked out into a temporary worktree.
 *              Without it the result has no speed ratio.
 * --order      which runs first; the workflow alternates it across runners so
 *              neither side always gets the fresher IP address.
 * --out        default .benchmark. Writes benchmark.json, summary.md, and per
 *              side <side>.trace.ndjson, <side>.log.txt and <side>.report.json.
 *
 * The workload, the checks and the measurement come from this checkout; only
 * the library under test comes from --candidate and --base. Exit code 1 when
 * the candidate's live check fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TraceEvent } from '../../src/types.ts';
import { type Library, liveCheck } from '../live-check/check.ts';
import { type ArmResult, type MachineResult, armMetrics, loadBenchmarkContract, machineSummary } from './lib.ts';

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

async function measure(side: 'candidate' | 'base', source: string): Promise<ArmResult> {
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
  return armMetrics(events, report, { source, commit, wallMs });
}

try {
  mkdirSync(outDir, { recursive: true });
  const candidateSource = flag('--candidate') ?? '.';
  const baseSource = flag('--base');
  const sides: ('candidate' | 'base')[] = baseSource ? (order === 'base-first' ? ['base', 'candidate'] : ['candidate', 'base']) : ['candidate'];
  const results: Partial<Record<'candidate' | 'base', ArmResult>> = {};
  for (const [i, side] of sides.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    results[side] = await measure(side, side === 'candidate' ? candidateSource : baseSource!);
  }
  const candidate = results.candidate!;
  const base = results.base ?? null;
  const machine: MachineResult = {
    version: 1,
    label,
    candidate,
    base,
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
