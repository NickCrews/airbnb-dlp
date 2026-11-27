import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/scheduler.ts';
import { manualClock } from '../src/testing/index.ts';

const tick = () => new Promise((r) => setImmediate(r));

describe('Scheduler', () => {
  it('spaces request starts by the rate', async () => {
    const clock = manualClock(0);
    const s = new Scheduler(clock, 2, 10);
    const starts: number[] = [];
    const signal = new AbortController().signal;
    for (let i = 0; i < 3; i++) void s.acquire(1, signal).then((release) => { starts.push(clock.now()); release(); });
    await tick();
    for (let i = 0; i < 4; i++) { clock.advance(250); await tick(); }
    expect(starts).toEqual([0, 500, 1000]);
  });

  it('caps requests in flight', async () => {
    const clock = manualClock(0);
    const s = new Scheduler(clock, 1000, 2);
    const signal = new AbortController().signal;
    const releases: (() => void)[] = [];
    for (let i = 0; i < 3; i++) void s.acquire(1, signal).then((r) => releases.push(r));
    for (let i = 0; i < 5; i++) { clock.advance(10); await tick(); }
    expect(releases).toHaveLength(2);
    releases[0]!();
    for (let i = 0; i < 5; i++) { clock.advance(10); await tick(); }
    expect(releases).toHaveLength(3);
  });

  it('serves waiting calls round-robin, so a long call cannot starve another', async () => {
    const clock = manualClock(0);
    const s = new Scheduler(clock, 1, 1);
    const signal = new AbortController().signal;
    const order: number[] = [];
    const take = (call: number) => s.acquire(call, signal).then((r) => { order.push(call); r(); });
    for (let i = 0; i < 5; i++) void take(1);
    for (let i = 0; i < 2; i++) void take(2);
    for (let i = 0; i < 10; i++) { clock.advance(1000); await tick(); }
    expect(order.slice(0, 5)).toEqual([1, 2, 1, 2, 1]);
  });

  it('rejects a waiter whose signal aborts', async () => {
    const clock = manualClock(0);
    const s = new Scheduler(clock, 1, 1);
    const busy = await s.acquire(1, new AbortController().signal);
    const ac = new AbortController();
    const p = s.acquire(2, ac.signal);
    ac.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    busy();
  });
});

describe('Scheduler pace', () => {
  it('starts at the initial rate and speeds up with healthy responses, up to the ceiling', () => {
    const s = new Scheduler(manualClock(0), 20, 8, { initial: 2 });
    expect(s.requestsPerSecond).toBe(2);
    for (let i = 0; i < 5; i++) s.succeeded();
    expect(s.requestsPerSecond).toBeCloseTo(2 * 1.1 ** 5);
    for (let i = 0; i < 200; i++) s.succeeded();
    expect(s.requestsPerSecond).toBe(20);
  });

  it('halves on a rate limit, then creeps back up rather than jumping', () => {
    const s = new Scheduler(manualClock(0), 20, 8, { initial: 8 });
    s.rateLimited(0);
    expect(s.requestsPerSecond).toBe(4);
    s.succeeded();
    expect(s.requestsPerSecond).toBeCloseTo(4 + 0.5 / 4);
  });

  it('never goes below the floor', () => {
    const s = new Scheduler(manualClock(0), 20, 8, { initial: 0.2 });
    for (let i = 0; i < 5; i++) s.rateLimited(0);
    expect(s.requestsPerSecond).toBe(0.1);
  });

  it('holds every request back for the pause a rate limit asks for', async () => {
    const clock = manualClock(0);
    const s = new Scheduler(clock, 1000, 10);
    const signal = new AbortController().signal;
    s.rateLimited(5000);
    let started = -1;
    void s.acquire(1, signal).then((release) => {
      started = clock.now();
      release();
    });
    for (let i = 0; i < 6; i++) {
      clock.advance(1000);
      await tick();
    }
    expect(started).toBe(5000);
  });

  it('reports slowdowns and speedups of 10% or more', () => {
    const reports: [number, string][] = [];
    const s = new Scheduler(manualClock(0), 20, 8, { initial: 2, onPace: (rate, reason) => reports.push([rate, reason]) });
    s.succeeded();
    s.rateLimited(1000);
    expect(reports.map((r) => r[1])).toEqual(['faster', 'rate-limited']);
  });
});

describe('Scheduler pace under a burst of rate limits', () => {
  it('halves once for limits that arrive during the same pause', () => {
    const clock = manualClock(0);
    const s = new Scheduler(clock, 100, 32, { initial: 64 });
    for (let i = 0; i < 32; i++) s.rateLimited(10_000);
    expect(s.requestsPerSecond).toBe(32);
    clock.advance(10_001);
    s.rateLimited(10_000);
    expect(s.requestsPerSecond).toBe(16);
  });
});
