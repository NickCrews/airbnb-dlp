export type ErrorCategory =
  | 'NotFound' // the listing is removed or hidden
  | 'StayUnavailable' // Airbnb will not quote the stay; the message is Airbnb's reason
  | 'RequestRejected'
  | 'ResponseChanged'
  | 'Blocked'
  | 'Transient' // still failing after retries
  | 'BudgetExhausted' // not attempted: maxRequests or maxDurationMs reached
  | 'Aborted' // the AbortSignal fired; its reason is the cause
  | 'Unknown';

export interface Exchange {
  request: { method: string; url: string; headers: Record<string, string>; body: string | null };
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean } | null;
}

/** Bodies over this many characters keep their start and set truncated. */
export const MAX_EXCHANGE_BODY = 1_000_000;

export class AirbnbError extends Error {
  readonly category: ErrorCategory;
  /**
   * The last HTTP exchange, bodies included. A body over 1 MB keeps its first
   * 1 MB and sets truncated, so many failed listing pages cannot exhaust memory.
   * Null when no request was made; response is null when none arrived.
   */
  readonly exchange: Exchange | null;

  constructor(
    category: ErrorCategory,
    message: string,
    options: { exchange?: Exchange | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = category === 'Blocked' ? 'BlockedError' : 'AirbnbError';
    this.category = category;
    this.exchange = options.exchange ?? null;
  }
}

/** Ends the whole call. Reported in Outcome.error, never thrown. */
export class BlockedError extends AirbnbError {
  constructor(message: string, options: { exchange?: Exchange | null; cause?: unknown } = {}) {
    super('Blocked', message, options);
  }
}

export function makeError(
  category: ErrorCategory,
  message: string,
  options: { exchange?: Exchange | null; cause?: unknown } = {},
): AirbnbError {
  return category === 'Blocked' ? new BlockedError(message, options) : new AirbnbError(category, message, options);
}
