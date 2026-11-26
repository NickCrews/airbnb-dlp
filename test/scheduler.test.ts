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
