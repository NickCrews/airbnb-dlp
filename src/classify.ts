import type { ErrorCategory } from './errors.ts';
import type { TransportResponse } from './types.ts';

/**
 * Sorts an HTTP response into a failure category, or null when the status is
 * one the caller should parse. Blocking is decided on status and on Akamai's
 * challenge markers, never on Airbnb's error page text, which is the same
 * generic page for 429 and 503.
 */
export function classifyResponse(response: TransportResponse): ErrorCategory | null {
  const { status } = response;
  if (status === 429 || status === 403 || status === 428) return 'Blocked';
  if (isChallenge(response)) return 'Blocked';
  if (status >= 500) return 'Transient';
  if (status >= 400) return 'RequestRejected';
  if (status >= 300) return 'ResponseChanged';
  return null;
}

/** Akamai's interstitial challenge, served with any status. */
export function isChallenge(response: TransportResponse): boolean {
  const location = header(response.headers, 'location') ?? '';
  if (location.includes('/_sec/cp_challenge/')) return true;
  return response.body.length < 200_000 && response.body.includes('/_sec/cp_challenge/');
}

export function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Transport failures: timeouts and network errors are transient. */
export function classifyThrown(error: unknown): ErrorCategory {
  if (error instanceof Error) {
    if (/timeout|timed out|abort|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|connect/i.test(`${error.name} ${error.message}`)) {
      return 'Transient';
    }
  }
  return 'Unknown';
}
