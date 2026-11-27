/**
 * Request identity and pacing: what every request says about itself and how
 * fast requests go. The repair agent may change these to match a current
 * browser, and may set the pace anywhere up to what Airbnb allows (AGENTS.md).
 * The TLS fingerprint lives in the transport (src/transport/).
 */

export const ORIGIN = 'https://www.airbnb.com';
/** Display text is requested in English so it parses the same everywhere. */
export const LOCALE = 'en';

export const HTML_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': LOCALE,
};

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'Accept-Language': LOCALE,
};

/**
 * The pace. A client starts at INITIAL_REQUESTS_PER_SECOND and adapts from
 * Airbnb's responses (src/scheduler.ts): faster while requests are served
 * normally, half as fast on a rate limit. DEFAULT_REQUESTS_PER_SECOND and
 * DEFAULT_CONCURRENCY are ceilings set well above what Airbnb sustains, so
 * the adaptive pace, not these numbers, decides how fast a client goes; the
 * benchmark's stress stage shows where it settles. Callers can only lower
 * them. The live check and the benchmark run at these defaults.
 */
export const INITIAL_REQUESTS_PER_SECOND = 2;
export const DEFAULT_REQUESTS_PER_SECOND = 100;
export const DEFAULT_CONCURRENCY = 32;
