/**
 * The benchmark's shared parts: its contract, the metrics computed from a
 * trace, and the JSON and Markdown it writes. `run.ts` measures one machine by
 * running the live check on each implementation; `merge.ts` combines
 * machines. Both write the same shapes, so one local run and a five-runner
 * workflow read the same way.
 */
import { readFileSync } from 'node:fs';
import type { ErrorCategory } from '../../src/errors.ts';
import type { Product, TraceEvent } from '../../src/types.ts';
import type { Report } from '../live-check/contract.ts';

const root = new URL('../../', import.meta.url);

export interface BenchmarkContract {
  /** Run the live check's pull-request set rather than the full one. */
  small: boolean;
  /** The stress stage: search the area for `listings` ids, then fetch all their reviews at the implementation's own pace. */
  stress: { area: string; nightlyPrice: { min: number; max: number }; listings: number; reviewsLimit: number };
  runners: number;
  minSpeedRatio: number;
}

export function loadBenchmarkContract(): BenchmarkContract {
  return JSON.parse(readFileSync(new URL('contract/benchmark.json', root), 'utf8')) as BenchmarkContract;
}

export interface ProductMetrics {
  calls: number;
  items: number;
  requests: number;
  ms: number;
  bytes: number;
}

/** One implementation's run of the workload on one machine. */
export interface ArmResult {
  /** What was measured: a git ref or a directory. */
  source: string;
  commit: string | null;
  startedAt: string;
  /** The live check's wall time, which the speed ratio compares; the stress stage is timed in `stress`. */
  wallMs: number;
  requests: number;
  bytes: number;
  /** Responses Airbnb refused outright: 403, 428 or a challenge page. */
  refusals: number;
  /** Rate limits the client slowed down for (a 429, or the API's 401 throttle): its `rate-limited` pace events. */
  rateLimits: number;
  retries: number;
  latencyMs: { p50: number; p95: number };
  /** Total time requests waited for the client's own pace and concurrency limits. */
  queuedMs: number;
  products: Partial<Record<Product, ProductMetrics>>;
  /** What ended a call early, if anything did. */
  error: ErrorCategory | null;
  /** The stress stage, or null when it did not run. */
  stress: StressResult | null;
  /** Whether its live check passed and its stress stage did not end early. */
  completed: boolean;
  /** The live check's failures and the stress stage's ending, for the summary. */
  problems: string[];
}

/** What the stress stage measured: how fast the implementation sustained requests, and where Airbnb pushed back. */
export interface StressResult {
  ms: number;
  requests: number;
  /** Requests a second, over the whole stage. */
  requestsPerSecond: number;
  rateLimits: number;
  refusals: number;
  /** The fastest pace the client reached, in requests a second; null when the trace has no pace events. */
  fastestPace: number | null;
  /** Reviews fetched, of those asked for. */
  items: number;
  ok: number;
  /** What ended the stage's calls early, if anything did. */
  error: ErrorCategory | null;
}

/** The stress stage's numbers, from its own trace. */
export function stressMetrics(events: TraceEvent[], run: { ms: number; items: number; ok: number; error: ErrorCategory | null }): StressResult {
  let requests = 0;
  let rateLimits = 0;
  let refusals = 0;
  let fastestPace: number | null = null;
  for (const e of events) {
    if (e.type === 'request') requests++;
    else if (e.type === 'response' && e.category === 'Blocked' && e.status !== 429) refusals++;
    else if (e.type === 'pace') {
      fastestPace = Math.max(fastestPace ?? 0, e.requestsPerSecond);
      if (e.reason === 'rate-limited') rateLimits++;
    }
  }
  return { ms: run.ms, requests, requestsPerSecond: requests / Math.max(run.ms / 1000, 0.001), rateLimits, refusals, fastestPace, items: run.items, ok: run.ok, error: run.error };
}

/** One machine's benchmark.json. */
export interface MachineResult {
  version: 1;
  label: string;
  candidate: ArmResult;
  base: ArmResult | null;
  /** base wall time / candidate wall time: above 1 means the candidate is faster. Null without a usable base. */
  speedRatio: number | null;
}

/** The merged benchmark.json across machines. */
export interface MergedResult {
  version: 1;
  machines: MachineResult[];
  candidate: { source: string; commit: string | null; completed: number; refusals: number; medianWallMs: number | null };
  base: { source: string; commit: string | null; completed: number; refusals: number; medianWallMs: number | null } | null;
  /** Median of the per-machine ratios, over machines where both arms completed. */
  speedRatio: number | null;
  verdict: { pass: boolean; reasons: string[] };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Metrics for one arm: performance from its trace, completion from its live-check report. */
export function armMetrics(events: TraceEvent[], report: Report, meta: { source: string; commit: string | null; wallMs: number }, stress: StressResult | null = null): ArmResult {
  const products: Partial<Record<Product, ProductMetrics>> = {};
  const productOfCall = new Map<number, Product>();
  const startOfCall = new Map<number, number>();
  let requests = 0;
  let bytes = 0;
  let refusals = 0;
  let rateLimits = 0;
  let retries = 0;
  let queuedMs = 0;
  let error: ErrorCategory | null = null;
  const latencies: number[] = [];
  const entry = (p: Product) => (products[p] ??= { calls: 0, items: 0, requests: 0, ms: 0, bytes: 0 });
  for (const e of events) {
    if (e.type === 'call.start') {
      productOfCall.set(e.call, e.product);
      startOfCall.set(e.call, e.at);
      entry(e.product).calls++;
    } else if (e.type === 'call.end') {
      const m = entry(e.product);
      m.ms += e.at - (startOfCall.get(e.call) ?? e.at);
      m.items += e.items;
      m.requests += e.requests;
      if (e.error && e.error !== 'BudgetExhausted') error ??= e.error;
    } else if (e.type === 'request') {
      requests++;
      queuedMs += e.queuedMs;
    } else if (e.type === 'response') {
      bytes += e.bytes;
      latencies.push(e.ms);
      const p = productOfCall.get(e.call);
      if (p) entry(p).bytes += e.bytes;
      if (e.category === 'Blocked' && e.status !== 429) refusals++;
    } else if (e.type === 'retry') {
      retries++;
    } else if (e.type === 'pace' && e.reason === 'rate-limited') {
      rateLimits++;
    }
  }
  return {
    source: meta.source,
    commit: meta.commit,
    startedAt: report.startedAt,
    wallMs: meta.wallMs,
    requests,
    bytes,
    refusals,
    rateLimits,
    retries,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    queuedMs,
    products,
    error,
    stress,
    completed: report.passed && (stress === null || stress.error === null),
    problems: [
      ...report.failures.map((f) => `[${f.category}] ${f.check}: ${f.message}`),
      ...(stress?.error ? [`stress stage ended early: ${stress.error}, after ${stress.requests} requests and ${stress.rateLimits} rate limits`] : []),
    ],
  };
}

/** Combines machines and applies the contract's bar. */
export function merge(machines: MachineResult[], contract: BenchmarkContract, reference?: MergedResult): MergedResult {
  const side = (pick: (m: MachineResult) => ArmResult | null) => {
    const arms = machines.map(pick).filter((a): a is ArmResult => a !== null);
    if (arms.length === 0) return null;
    return {
      source: arms[0]!.source,
      commit: arms[0]!.commit,
      completed: arms.filter((a) => a.completed).length,
      // Hard refusals in either stage; rate limits waited out do not count.
      refusals: arms.reduce((n, a) => n + a.refusals + (a.stress?.refusals ?? 0), 0),
      medianWallMs: median(arms.filter((a) => a.completed).map((a) => a.wallMs)),
    };
  };
  const candidate = side((m) => m.candidate)!;
  const base = side((m) => m.base);
  let speedRatio = median(machines.flatMap((m) => (m.speedRatio === null ? [] : [m.speedRatio])));
  const reasons: string[] = [];
  let pass = true;

  if (candidate.completed < machines.length) {
    pass = false;
    reasons.push(`the candidate's live check passed on ${candidate.completed} of ${machines.length} machines`);
  }
  // A base that fails the workload on most machines, like a broken main, is no yardstick.
  const baseUsable = base !== null && base.completed * 2 > machines.length;
  if (base && !baseUsable) reasons.push(`the base's live check passed on ${base.completed} of ${machines.length} machines, so it is not compared`);
  if (baseUsable && candidate.refusals > base!.refusals) {
    pass = false;
    reasons.push(`the candidate was refused ${candidate.refusals} times, the base ${base!.refusals}`);
  }
  if (!baseUsable && reference?.candidate.medianWallMs && candidate.medianWallMs) {
    // The reference is an earlier benchmark of a working main: compare medians across runs.
    speedRatio = reference.candidate.medianWallMs / candidate.medianWallMs;
    reasons.push(`compared with an earlier benchmark of ${reference.candidate.source} (${reference.candidate.commit?.slice(0, 7) ?? 'unknown commit'})`);
  }
  if (speedRatio !== null && speedRatio < contract.minSpeedRatio) {
    pass = false;
    reasons.push(`speed ratio ${speedRatio.toFixed(2)} is below the minimum ${contract.minSpeedRatio}`);
  }
  if (speedRatio === null) reasons.push('no speed comparison: run with a base, or a reference, to compare');
  if (pass) reasons.unshift('passes');
  return { version: 1, machines, candidate, base, speedRatio, verdict: { pass, reasons } };
}

const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

function armRow(machine: string, arm: string, a: ArmResult): string {
  return `| ${machine} | ${arm} | ${a.completed ? 'passed' : 'failed'} | ${seconds(a.wallMs)} | ${a.requests} | ${a.refusals} | ${a.rateLimits} | ${a.retries} | ${a.latencyMs.p50} / ${a.latencyMs.p95} ms | ${kb(a.bytes)} |`;
}

function stressRow(machine: string, arm: string, s: StressResult | null): string[] {
  if (!s) return [];
  const pace = s.fastestPace === null ? '–' : `${s.fastestPace.toFixed(1)}/s`;
  return [`| ${machine} | ${arm} | ${s.requestsPerSecond.toFixed(1)}/s | ${s.requests} | ${s.rateLimits} | ${s.refusals} | ${pace} | ${s.ok} of ${s.items} | ${s.error ?? 'finished'} |`];
}

export function machineSummary(m: MachineResult): string {
  return mergedSummary({ version: 1, machines: [m], ...summaryHead(m) });
}

function summaryHead(m: MachineResult): Omit<MergedResult, 'version' | 'machines'> {
  const pick = (a: ArmResult | null) => a && { source: a.source, commit: a.commit, completed: a.completed ? 1 : 0, refusals: a.refusals, medianWallMs: a.completed ? a.wallMs : null };
  return { candidate: pick(m.candidate)!, base: pick(m.base), speedRatio: m.speedRatio, verdict: { pass: m.candidate.completed, reasons: m.candidate.problems } };
}

export function mergedSummary(r: MergedResult): string {
  const name = (s: { source: string; commit: string | null }) => `\`${s.source}\`${s.commit ? ` (${s.commit.slice(0, 7)})` : ''}`;
  const lines: string[] = [
    `## Benchmark: ${r.verdict.pass ? 'pass' : 'FAIL'}`,
    '',
    `Candidate ${name(r.candidate)}${r.base ? `, base ${name(r.base)}` : ''}, ${r.machines.length} machine${r.machines.length === 1 ? '' : 's'}.`,
    '',
    r.speedRatio === null ? 'Speed: not compared.' : `Speed: the candidate runs the workload **${r.speedRatio.toFixed(2)}×** as fast as the base (median of per-machine ratios; above 1 is faster).`,
    `Median live-check time: candidate ${seconds(r.candidate.medianWallMs)}${r.base ? `, base ${seconds(r.base.medianWallMs)}` : ''}.`,
    '',
    ...r.verdict.reasons.map((x) => `- ${x}`),
    '',
    '| Machine | Arm | Completed | Time | Requests | Refused | Rate limits | Retries | Latency p50 / p95 | Bytes |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...r.machines.flatMap((m) => [armRow(m.label, 'candidate', m.candidate), ...(m.base ? [armRow(m.label, 'base', m.base)] : [])]),
    '',
  ];
  const stress = r.machines.flatMap((m) => [...stressRow(m.label, 'candidate', m.candidate.stress), ...stressRow(m.label, 'base', m.base?.stress ?? null)]);
  if (stress.length > 0) {
    lines.push(
      '### Stress stage',
      '',
      'Reviews for a few hundred listings, as fast as each pace allows, until Airbnb rate-limits it.',
      '',
      '| Machine | Arm | Sustained | Requests | Rate limits | Refused | Fastest pace | Reviews fetched | Ended |',
      '|---|---|---|---|---|---|---|---|---|',
      ...stress,
      '',
    );
  }
  const problems = r.machines.flatMap((m) =>
    [['candidate', m.candidate] as const, ['base', m.base] as const].flatMap(([arm, a]) => (a ? a.problems.map((p) => `- ${m.label} ${arm}: ${p}`) : [])),
  );
  if (problems.length > 0) lines.push('### Problems', '', ...problems, '');
  const products = (['search', 'listings', 'calendars', 'priceQuotes', 'reviews'] as Product[]).flatMap((p) => {
    const c = r.machines.map((m) => m.candidate.products[p]).filter(Boolean) as ProductMetrics[];
    if (c.length === 0) return [];
    const b = r.machines.map((m) => m.base?.products[p]).filter(Boolean) as ProductMetrics[];
    const cell = (xs: ProductMetrics[]) =>
      xs.length === 0 ? '–' : `${seconds(median(xs.map((x) => x.ms)))}, ${median(xs.map((x) => x.items))} items, ${median(xs.map((x) => x.requests))} req, ${kb(median(xs.map((x) => x.bytes)) ?? 0)}`;
    return [`| ${p} | ${cell(c)} | ${cell(b)} |`];
  });
  lines.push('### Per product (medians)', '', '| Product | Candidate | Base |', '|---|---|---|', ...products, '');
  return lines.join('\n');
}
