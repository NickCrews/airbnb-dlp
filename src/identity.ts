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
 * The default pace. The live check runs at it, so a pace Airbnb refuses fails
 * the live check and the repair agent lowers it. Callers can only lower these.
 */
export const DEFAULT_REQUESTS_PER_SECOND = 1;
export const DEFAULT_CONCURRENCY = 4;
