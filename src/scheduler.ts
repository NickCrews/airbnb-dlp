import type { Clock } from './types.ts';

interface Waiter {
  resolve(release: () => void): void;
  reject(reason: unknown): void;
}

/** Why the pace changed, as the trace reports it. */
export type PaceReason = 'faster' | 'rate-limited';

export interface PaceOptions {
  /** The rate to start at. Default: the ceiling, which keeps the pace fixed until something reports back. */
  initial?: number;
  /** Receives each change of rate that matters: every slowdown, and speedups of 10% or more. */
  onPace?: (rate: number, reason: PaceReason, pauseMs: number) => void;
}

/** The slowest the pace goes after rate limits, in requests a second. */
export const MIN_REQUESTS_PER_SECOND = 0.1;
/** Speedup per healthy response before the first rate limit: the pace finds its level quickly. */
const SLOW_START_FACTOR = 1.1;
/** Speedup per healthy response after a rate limit: rate += this / rate, so it creeps back up. */
const ADDITIVE_INCREASE = 0.5;

/**
 * One request budget for a client: a spacing between request starts that
 * adapts to Airbnb's responses, and a cap on requests in flight. Slots go
 * round-robin across the calls that are waiting, so a long call cannot starve
 * another.
 *
 * The pace works like TCP's congestion control. Each healthy response speeds
 * it up: by 10% until the first rate limit, then by a little. A rate limit
 * halves it, pauses every request for the server's Retry-After, and makes half
 * the old rate the point where fast speedup stops. The pace never goes above
 * the ceiling, which callers can only lower.
 */
export class Scheduler {
  private rate: number;
  private readonly ceiling: number;
  private slowStartUntil: number;
  private reportedRate: number;
  private readonly onPace: PaceOptions['onPace'];
  private readonly concurrency: number;
  private readonly queues = new Map<number, Waiter[]>();
  private ring: number[] = [];
  private turn = 0;
  private active = 0;
  private nextAt = -Infinity;
  private pumping = false;
  private readonly clock: Clock;

  constructor(clock: Clock, ceiling: number, concurrency: number, options: PaceOptions = {}) {
    this.clock = clock;
    this.ceiling = ceiling;
    this.rate = Math.min(options.initial ?? ceiling, ceiling);
    this.reportedRate = this.rate;
    this.slowStartUntil = ceiling;
    this.onPace = options.onPace;
    this.concurrency = concurrency;
  }

  /** The current pace, in requests a second. */
  get requestsPerSecond(): number {
    return this.rate;
  }

  /** A response Airbnb served normally: speed up. */
  succeeded(): void {
    const next = this.rate < this.slowStartUntil ? this.rate * SLOW_START_FACTOR : this.rate + ADDITIVE_INCREASE / this.rate;
    this.rate = Math.min(this.ceiling, next);
    if (this.rate >= this.reportedRate * 1.1 || (this.rate === this.ceiling && this.reportedRate < this.ceiling)) {
      this.reportedRate = this.rate;
      this.onPace?.(this.rate, 'faster', 0);
    }
  }

  /** A rate limit: halve the pace and hold every request back for `pauseMs`. */
  rateLimited(pauseMs: number): void {
    this.rate = Math.max(MIN_REQUESTS_PER_SECOND, this.rate / 2);
    this.slowStartUntil = this.rate;
    this.reportedRate = this.rate;
    this.nextAt = Math.max(this.nextAt, this.clock.now() + pauseMs);
    this.onPace?.(this.rate, 'rate-limited', pauseMs);
  }

  /** Resolves with a release function once a request may start. */
  acquire(callId: number, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let queue = this.queues.get(callId);
      if (!queue) {
        queue = [];
        this.queues.set(callId, queue);
        this.ring.push(callId);
      }
      const waiter: Waiter = {
        resolve: (release) => {
          signal.removeEventListener('abort', onAbort);
          resolve(release);
        },
        reject,
      };
      const onAbort = () => {
        const q = this.queues.get(callId);
        const i = q ? q.indexOf(waiter) : -1;
        if (q && i >= 0) q.splice(i, 1);
        this.prune(callId);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
      void this.pump();
    });
  }

  private prune(callId: number): void {
    const q = this.queues.get(callId);
    if (q && q.length === 0) {
      this.queues.delete(callId);
      this.ring = this.ring.filter((id) => id !== callId);
    }
  }

  private next(): Waiter | undefined {
    for (let n = 0; n < this.ring.length; n++) {
      const idx = (this.turn + n) % this.ring.length;
      const callId = this.ring[idx]!;
      const q = this.queues.get(callId);
      const w = q?.shift();
      if (w) {
        this.turn = idx + 1;
        this.prune(callId);
        return w;
      }
    }
    return undefined;
  }

  private hasWaiters(): boolean {
    return this.ring.length > 0;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active < this.concurrency && this.hasWaiters()) {
        const wait = this.nextAt - this.clock.now();
        if (wait > 0) {
          await this.clock.sleep(wait, new AbortController().signal);
          continue;
        }
        const waiter = this.next();
        if (!waiter) break;
        this.active++;
        this.nextAt = Math.max(this.clock.now(), this.nextAt) + 1000 / this.rate;
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}
