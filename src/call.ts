import { classifyResponse, classifyThrown } from './classify.ts';
import { AirbnbError, BlockedError, type Exchange, MAX_EXCHANGE_BODY, makeError } from './errors.ts';
import { MarkerMissingError, ShapeError } from './parse-errors.ts';
import type { Scheduler } from './scheduler.ts';
import type {
  Batch,
  CallOptions,
  Clock,
  Inputs,
  Outcome,
  Transport,
  TransportRequest,
  TransportResponse,
} from './types.ts';

export interface ClientContext {
  transport: Transport;
  clock: Clock;
  random: () => number;
  scheduler: Scheduler;
  currency: string;
  concurrency: number;
  nextCallId(): number;
  /** Airbnb's public web API key, read from the homepage once per client. */
  apiKey: { value: string | null; pending: Promise<string> | null };
}

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RETRIES = 3;
export const RETRY_BASE_MS = 2_000;
/** Items a batch holds unread before it pauses new requests. */
export const BUFFER_SIZE = 16;

export interface FetchResult {
  response: TransportResponse;
  exchange: Exchange;
}

function captureExchange(request: TransportRequest, response: TransportResponse | null): Exchange {
  return {
    request: { method: request.method, url: request.url, headers: { ...request.headers }, body: request.body },
    response: response
      ? {
          status: response.status,
          headers: { ...response.headers },
          body: response.body.length > MAX_EXCHANGE_BODY ? response.body.slice(0, MAX_EXCHANGE_BODY) : response.body,
          truncated: response.body.length > MAX_EXCHANGE_BODY,
        }
      : null,
  };
}

class TimeoutError extends Error {
  constructor() {
    super(`request timed out after ${REQUEST_TIMEOUT_MS} ms`);
    this.name = 'TimeoutError';
  }
}

/** The state one bulk call shares across its inputs: budget, stop signal, buffer gate. */
export class Call {
  readonly id: number;
  readonly ctx: ClientContext;
  requests = 0;
  error: AirbnbError | null = null;
  private readonly controller = new AbortController();
  private readonly maxRequests: number;
  private readonly deadline: number;
  gate: () => Promise<void> = () => Promise.resolve();

  constructor(ctx: ClientContext, options: CallOptions) {
    this.ctx = ctx;
    this.id = ctx.nextCallId();
    this.maxRequests = options.maxRequests ?? Infinity;
    this.deadline = options.maxDurationMs === undefined ? Infinity : ctx.clock.now() + options.maxDurationMs;
    const signal = options.signal;
    if (signal) {
      const onAbort = () =>
        this.stop(new AirbnbError('Aborted', 'the call was aborted', { cause: signal.reason }));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get stopped(): boolean {
    return this.error !== null;
  }

  /** Ends the call: no new requests start, and requests in flight are aborted. */
  stop(error: AirbnbError): void {
    if (this.error) return;
    this.error = error;
    this.controller.abort(error);
  }

  private checkBudget(): void {
    if (this.error) throw this.error;
    if (this.requests >= this.maxRequests) {
      throw new AirbnbError('BudgetExhausted', `maxRequests (${this.maxRequests}) reached`);
    }
    if (this.ctx.clock.now() >= this.deadline) {
      throw new AirbnbError('BudgetExhausted', 'maxDurationMs reached');
    }
  }

  private async sleep(ms: number): Promise<void> {
    try {
      await this.ctx.clock.sleep(ms, this.signal);
    } catch {
      throw this.error ?? new AirbnbError('Aborted', 'the call was aborted');
    }
  }

  private async send(request: TransportRequest): Promise<TransportResponse> {
    const attempt = new AbortController();
    const onStop = () => attempt.abort(this.signal.reason);
    this.signal.addEventListener('abort', onStop, { once: true });
    const timer = new AbortController();
    try {
      const timeout = this.ctx.clock.sleep(REQUEST_TIMEOUT_MS, timer.signal).then(
        () => {
          attempt.abort(new TimeoutError());
          throw new TimeoutError();
        },
        () => new Promise<never>(() => {}),
      );
      return await Promise.race([this.ctx.transport(request, attempt.signal), timeout]);
    } finally {
      timer.abort();
      this.signal.removeEventListener('abort', onStop);
    }
  }

  /**
   * Sends one request through the client's budget, retrying transient
   * failures. Statuses in `accept` are returned for the product to interpret;
   * any other failure is thrown as an AirbnbError. A Blocked response ends the call.
   */
  async fetch(request: TransportRequest, accept: readonly number[] = []): Promise<FetchResult> {
    for (let attempt = 0; ; attempt++) {
      this.checkBudget();
      await this.gate();
      this.checkBudget();
      let release: () => void;
      try {
        release = await this.ctx.scheduler.acquire(this.id, this.signal);
      } catch {
        throw this.error ?? new AirbnbError('Aborted', 'the call was aborted');
      }
      let response: TransportResponse;
      try {
        this.checkBudget();
        this.requests++;
        response = await this.send(request);
      } catch (cause) {
        release();
        if (this.error) throw this.error;
        if (cause instanceof AirbnbError) throw cause;
        const category = classifyThrown(cause);
        const exchange = captureExchange(request, null);
        if (category === 'Transient' && attempt < MAX_RETRIES) {
          await this.backoff(attempt);
          continue;
        }
        throw makeError(category, `request failed: ${String(cause)}`, { exchange, cause });
      }
      release();
      const exchange = captureExchange(request, response);
      if (accept.includes(response.status)) return { response, exchange };
      const category = classifyResponse(response);
      if (category === null) return { response, exchange };
      if (category === 'Blocked') {
        const error = new BlockedError(`blocked: HTTP ${response.status} from ${request.url}`, { exchange });
        this.stop(error);
        throw error;
      }
      if (category === 'Transient' && attempt < MAX_RETRIES) {
        await this.backoff(attempt);
        continue;
      }
      throw makeError(category, `HTTP ${response.status} from ${request.url}`, { exchange });
    }
  }

  private backoff(attempt: number): Promise<void> {
    return this.sleep(RETRY_BASE_MS * 2 ** attempt * (0.5 + this.ctx.random()));
  }

  /** Runs a parser on a fetched response, mapping its failures to categories. */
  parse<T>(result: FetchResult, parser: (body: string) => T): T {
    try {
      return parser(result.response.body);
    } catch (cause) {
      throw this.parseError(cause, result.exchange);
    }
  }

  parseError(cause: unknown, exchange: Exchange): AirbnbError {
    if (cause instanceof AirbnbError) return cause;
    if (cause instanceof MarkerMissingError) {
      const error = new BlockedError(cause.message, { exchange, cause });
      this.stop(error);
      return error;
    }
    if (cause instanceof ShapeError || cause instanceof SyntaxError || cause instanceof TypeError) {
      return new AirbnbError('ResponseChanged', `response did not parse: ${cause.message}`, { exchange, cause });
    }
    return new AirbnbError('Unknown', String(cause), { exchange, cause });
  }
}

export function toAirbnbError(error: unknown): AirbnbError {
  if (error instanceof AirbnbError) return error;
  return new AirbnbError('Unknown', String(error), { cause: error });
}

// ---------------------------------------------------------------- items buffer

class Channel<T> {
  private readonly queue: T[] = [];
  private closed = false;
  private discard = false;
  private spaceWaiters: (() => void)[] = [];
  private itemWaiter: (() => void) | null = null;

  waitForSpace(): Promise<void> {
    if (this.discard || this.queue.length < BUFFER_SIZE) return Promise.resolve();
    return new Promise((resolve) => this.spaceWaiters.push(resolve));
  }

  async push(item: T): Promise<void> {
    await this.waitForSpace();
    if (this.discard) return;
    this.queue.push(item);
    this.wakeReader();
  }

  close(): void {
    this.closed = true;
    this.wakeReader();
  }

  drain(): void {
    this.discard = true;
    this.queue.length = 0;
    this.wakeWriters();
  }

  private wakeReader(): void {
    const w = this.itemWaiter;
    this.itemWaiter = null;
    w?.();
  }

  private wakeWriters(): void {
    const ws = this.spaceWaiters;
    this.spaceWaiters = [];
    for (const w of ws) w();
  }

  async *read(): AsyncGenerator<T> {
    for (;;) {
      if (this.queue.length > 0) {
        const item = this.queue.shift() as T;
        if (this.queue.length < BUFFER_SIZE) this.wakeWriters();
        yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.itemWaiter = resolve));
    }
  }
}

function iterate<T>(inputs: Inputs<T>): AsyncIterator<T> {
  if (Symbol.asyncIterator in inputs) return (inputs as AsyncIterable<T>)[Symbol.asyncIterator]();
  const it = (inputs as Iterable<T>)[Symbol.iterator]();
  return {
    next: async () => it.next(),
    return: async (value?: unknown) => it.return?.(value) ?? { done: true, value: undefined },
  };
}

/**
 * Work for one input. It emits items and returns the reason the input is
 * incomplete, or null. It must not throw.
 */
export type InputWork<I, T> = (call: Call, input: I, emit: (item: T) => Promise<void>) => Promise<AirbnbError | null>;

export function startBatch<I, T>(
  ctx: ClientContext,
  options: CallOptions,
  inputs: Inputs<I>,
  work: InputWork<I, T>,
): Batch<I, T> {
  const call = new Call(ctx, options);
  const channel = new Channel<T>();
  call.gate = () => channel.waitForSpace();
  const incomplete: { input: I; error: AirbnbError }[] = [];
  const emit = (item: T) => channel.push(item);

  const drive = async (): Promise<Outcome<I>> => {
    const iterator = iterate(inputs);
    const inflight = new Set<Promise<void>>();
    try {
      for (;;) {
        while (inflight.size >= ctx.concurrency) await Promise.race(inflight);
        if (call.stopped) break;
        let next: IteratorResult<I>;
        try {
          next = await iterator.next();
        } catch (cause) {
          call.stop(new AirbnbError('Unknown', `reading inputs failed: ${String(cause)}`, { cause }));
          break;
        }
        if (next.done) break;
        const input = next.value;
        const task = work(call, input, emit).then(
          (error) => {
            if (error) incomplete.push({ input, error });
          },
          (cause) => {
            incomplete.push({ input, error: toAirbnbError(cause) });
          },
        );
        inflight.add(task);
        void task.finally(() => inflight.delete(task));
      }
      await Promise.all(inflight);
      if (call.stopped) await iterator.return?.().catch(() => undefined);
    } finally {
      channel.close();
    }
    return { error: call.error, incomplete, requests: call.requests };
  };

  const done = drive().catch(
    (cause): Outcome<I> => ({ error: toAirbnbError(cause), incomplete, requests: call.requests }),
  );
  let read = false;

  return {
    items(): AsyncIterable<T> {
      if (read) throw new Error('items() can be read only once');
      read = true;
      const source = channel.read();
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => source.next(),
          return: async () => {
            channel.drain();
            call.stop(new AirbnbError('Aborted', 'the reader stopped reading items'));
            await source.return(undefined);
            return { done: true, value: undefined };
          },
        }),
      };
    },
    outcome(): Promise<Outcome<I>> {
      if (!read) {
        read = true;
        channel.drain();
      }
      return done;
    },
    async all() {
      const items: T[] = [];
      for await (const item of this.items()) items.push(item);
      return { items, outcome: await done };
    },
  };
}

/** A batch of single-value products: one Result per input. */
export function startResultBatch<I, T>(
  ctx: ClientContext,
  options: CallOptions,
  inputs: Inputs<I>,
  fetchOne: (call: Call, input: I) => Promise<T>,
) {
  return startBatch<I, { input: I; ok: true; value: T } | { input: I; ok: false; error: AirbnbError }>(
    ctx,
    options,
    inputs,
    async (call, input, emit) => {
      try {
        const value = await fetchOne(call, input);
        await emit({ input, ok: true, value });
        return null;
      } catch (cause) {
        const error = toAirbnbError(cause);
        await emit({ input, ok: false, error });
        return error;
      }
    },
  );
}
