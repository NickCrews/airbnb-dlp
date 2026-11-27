/**
 * Request identity and pacing: what every request says about itself and how
 * fast requests go. The repair agent may change these to match current Chrome
 * or to go slower, never faster (AGENTS.md); such changes need the maintainer's
 * review. The TLS fingerprint lives in the transport (src/transport/).
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

/** Airbnb allows about 130 requests a minute per IP; the default stays well under it. Callers can only lower these. */
export const DEFAULT_REQUESTS_PER_SECOND = 1;
export const DEFAULT_CONCURRENCY = 4;
