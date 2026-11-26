import type { Clock } from './types.ts';

interface Waiter {
  resolve(release: () => void): void;
  reject(reason: unknown): void;
}

/**
 * One request budget for a client: a minimum spacing between request starts
 * and a cap on requests in flight. Slots go round-robin across the calls that
 * are waiting, so a long call cannot starve another.
 */
export class Scheduler {
  private readonly interval: number;
  private readonly concurrency: number;
  private readonly queues = new Map<number, Waiter[]>();
  private ring: number[] = [];
  private turn = 0;
  private active = 0;
  private nextAt = -Infinity;
  private pumping = false;
  private readonly clock: Clock;

  constructor(clock: Clock, requestsPerSecond: number, concurrency: number) {
    this.clock = clock;
    this.interval = 1000 / requestsPerSecond;
    this.concurrency = concurrency;
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
        this.nextAt = Math.max(this.clock.now(), this.nextAt) + this.interval;
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
