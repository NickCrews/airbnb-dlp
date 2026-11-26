/**
 * The only core module that touches the system clock, timers and random
 * source. Everything else receives them through the client.
 */
import type { Clock } from './types.ts';

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

export const systemRandom = (): number => Math.random();
