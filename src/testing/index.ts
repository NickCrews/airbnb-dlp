/**
 * Test helpers for code that uses airbnb-dlp: record live exchanges, replay
 * them without a network, and drive time by hand.
 */
import type { Clock, Transport, TransportRequest, TransportResponse } from '../types.ts';

/** One complete HTTP exchange. */
export interface Recording {
  /** ISO 8601 UTC time the response arrived. */
  recordedAt: string;
  request: TransportRequest;
  response: TransportResponse;
}

/** Wraps a transport and keeps every exchange it completes. */
export function recordingTransport(inner: Transport): Transport & { recordings(): Recording[] } {
  const recordings: Recording[] = [];
  const transport = (async (request: TransportRequest, signal: AbortSignal) => {
    const response = await inner(request, signal);
    recordings.push({
      recordedAt: new Date().toISOString(),
      request: { ...request, headers: { ...request.headers } },
      response: { ...response, headers: { ...response.headers } },
    });
    return response;
  }) as Transport & { recordings(): Recording[] };
  transport.recordings = () => recordings.slice();
  return transport;
}

export function exchangeKey(request: TransportRequest): string {
  return `${request.method} ${request.url}\n${request.body ?? ''}`;
}

/**
 * Answers each request with a recorded response to the same method, URL and
 * body, in recorded order; a request with no recording left rejects.
 * Header values such as the API key do not affect matching.
 */
export function replayTransport(recordings: Recording[]): Transport {
  const queues = new Map<string, TransportResponse[]>();
  for (const r of recordings) {
    const key = exchangeKey(r.request);
    const q = queues.get(key) ?? [];
    q.push(r.response);
    queues.set(key, q);
  }
  return async (request, signal) => {
    if (signal.aborted) throw signal.reason;
    const q = queues.get(exchangeKey(request));
    const response = q?.shift();
    if (!response) throw new Error(`no recording for ${request.method} ${request.url}`);
    return { ...response, headers: { ...response.headers } };
  };
}

/** sleep() resolves only when advance() passes its deadline. */
export function manualClock(startMs: number): Clock & { advance(ms: number): void } {
  let now = startMs;
  let timers: { at: number; resolve: () => void }[] = [];
  return {
    now: () => now,
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = {
          at: now + Math.max(0, ms),
          resolve: () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          timers = timers.filter((t) => t !== timer);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timers.push(timer);
      });
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.resolve();
    },
  };
}
