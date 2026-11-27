import { describe, expect, it } from 'vitest';
import { type ArmResult, type MachineResult, type StressResult, armMetrics, merge, mergedSummary } from '../scripts/benchmark/lib.ts';
import type { Report } from '../scripts/live-check/contract.ts';
import type { TraceEvent } from '../src/types.ts';

const contract = { small: true, runners: 5, minSpeedRatio: 0.9, stress: { area: 'austin-tx', nightlyPrice: { min: 50, max: 1000 }, listings: 300, reviewsLimit: 6 } };

function arm(wallMs: number, overrides: Partial<ArmResult> = {}): ArmResult {
  return {
    source: 'x',
    commit: 'abc1234',
    startedAt: '2026-11-27T00:00:00Z',
    wallMs,
    requests: 55,
    bytes: 1,
    refusals: 0,
    rateLimits: 0,
    retries: 0,
    latencyMs: { p50: 1, p95: 2 },
    queuedMs: 0,
    products: {},
    error: null,
    stress: null,
    completed: true,
    problems: [],
    ...overrides,
  };
}

function machine(label: string, candidate: ArmResult, base: ArmResult | null): MachineResult {
  return { version: 1, label, candidate, base, speedRatio: base && base.completed && candidate.completed ? base.wallMs / candidate.wallMs : null };
}

describe('benchmark verdict', () => {
  it('passes a candidate that completes everywhere at the base speed or better', () => {
    const r = merge([machine('a', arm(50_000), arm(60_000)), machine('b', arm(30_000), arm(30_000))], contract);
    expect(r.verdict.pass).toBe(true);
    expect(r.speedRatio).toBeCloseTo(1.1);
  });

  it('fails a candidate that fixes things by being much slower', () => {
    const r = merge([machine('a', arm(200_000), arm(60_000)), machine('b', arm(120_000), arm(40_000))], contract);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.reasons.join(' ')).toContain('below the minimum 0.9');
  });

  it('fails a candidate whose live check fails on any machine', () => {
    const r = merge([machine('a', arm(50_000), arm(50_000)), machine('b', arm(50_000, { completed: false }), arm(50_000))], contract);
    expect(r.verdict.pass).toBe(false);
  });

  it('fails a candidate refused more often than the base', () => {
    const r = merge([machine('a', arm(50_000, { refusals: 1 }), arm(50_000))], contract);
    expect(r.verdict.pass).toBe(false);
  });

  it('does not compare with a base that fails its own live check, and falls back to a reference', () => {
    const broken = arm(10_000, { completed: false });
    const alone = merge([machine('a', arm(50_000), broken), machine('b', arm(50_000), broken)], contract);
    expect(alone.speedRatio).toBeNull();
    expect(alone.verdict.pass).toBe(true);
    expect(alone.verdict.reasons.join(' ')).toContain('not compared');

    const reference = merge([machine('r', arm(20_000), null)], contract);
    const slow = merge([machine('a', arm(50_000), broken)], contract, reference);
    expect(slow.speedRatio).toBeCloseTo(0.4);
    expect(slow.verdict.pass).toBe(false);
  });

  it('fails a side whose stress stage ends early, and counts its hard refusals', () => {
    const stress = (o: Partial<StressResult>): StressResult => ({ ms: 20_000, requests: 300, requestsPerSecond: 15, rateLimits: 4, refusals: 0, fastestPace: 30, items: 300, ok: 300, error: null, ...o });
    const report: Report = { startedAt: '2026-11-27T00:00:00Z', finishedAt: '2026-11-27T00:00:01Z', small: true, requests: 55, passed: true, failures: [], fillRates: null };
    const waitedOut = armMetrics([], report, { source: '.', commit: null, wallMs: 1 }, stress({}));
    expect(waitedOut.completed).toBe(true);
    const ended = armMetrics([], report, { source: '.', commit: null, wallMs: 1 }, stress({ error: 'Blocked' }));
    expect(ended.completed).toBe(false);
    expect(ended.problems.join(' ')).toContain('stress stage ended early: Blocked');
    const refused = merge([machine('a', arm(50_000, { stress: stress({ refusals: 2 }) }), arm(50_000))], contract);
    expect(refused.verdict.pass).toBe(false);
  });

  it('reports absolute numbers without a base', () => {
    const r = merge([machine('local', arm(45_000), null)], contract);
    expect(r.speedRatio).toBeNull();
    expect(r.verdict.pass).toBe(true);
    expect(mergedSummary(r)).toContain('45.0 s');
  });
});

describe('benchmark metrics', () => {
  it('reads requests, refusals, bytes and per-product time from the trace', () => {
    const events: TraceEvent[] = [
      { type: 'call.start', at: 0, call: 1, product: 'listings' },
      { type: 'request', at: 0, call: 1, request: 1, attempt: 0, method: 'GET', url: 'https://www.airbnb.com/rooms/1', queuedMs: 5 },
      { type: 'response', at: 100, call: 1, request: 1, attempt: 0, status: 200, bytes: 1000, ms: 100, category: null },
      { type: 'request', at: 1000, call: 1, request: 2, attempt: 0, method: 'GET', url: 'https://www.airbnb.com/rooms/2', queuedMs: 900 },
      { type: 'response', at: 1100, call: 1, request: 2, attempt: 0, status: 429, bytes: 10, ms: 100, category: 'Blocked' },
      { type: 'pace', at: 1100, requestsPerSecond: 1, reason: 'rate-limited', pauseMs: 2000 },
      { type: 'call.end', at: 1100, call: 1, product: 'listings', items: 2, requests: 2, incomplete: 1, error: 'Blocked' },
    ];
    const report: Report = { startedAt: '2026-11-27T00:00:00Z', finishedAt: '2026-11-27T00:00:01Z', small: true, requests: 2, passed: false, failures: [{ category: 'Blocked', check: 'listings', message: 'Airbnb blocked the run' }], fillRates: null };
    const a = armMetrics(events, report, { source: '.', commit: null, wallMs: 1100 });
    expect(a).toMatchObject({ requests: 2, refusals: 0, rateLimits: 1, bytes: 1010, queuedMs: 905, error: 'Blocked', completed: false });
    expect(a.products.listings).toMatchObject({ calls: 1, items: 2, requests: 2, ms: 1100, bytes: 1010 });
    expect(a.problems).toEqual(['[Blocked] listings: Airbnb blocked the run']);
  });
});
