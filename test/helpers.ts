import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { makeCreateClient } from '../src/client.ts';
import type { ClientOptions, Transport, TransportRequest, TransportResponse } from '../src/types.ts';
import { instantClock } from './fixture-suite.ts';

export const createClient = makeCreateClient(null);

export const HOMEPAGE = '<html><script>{"api_config":{"key":"test-key","baseUrl":"/api"}}</script></html>';

export function ok(body: string, status = 200): TransportResponse {
  return { status, headers: {}, body };
}

/** A transport answered by a function, with the homepage's API key served automatically. */
export function fakeTransport(handler: (req: TransportRequest) => TransportResponse | Promise<TransportResponse>): Transport & { requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  const t = (async (req: TransportRequest, signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason;
    requests.push(req);
    if (/^https:\/\/www\.airbnb\.com\/\?locale=en$/.test(req.url)) return ok(HOMEPAGE);
    return handler(req);
  }) as Transport & { requests: TransportRequest[] };
  t.requests = requests;
  return t;
}

export function testClient(transport: Transport, options: ClientOptions = {}) {
  return createClient({ transport, clock: instantClock(Date.UTC(2026, 10, 26)), random: () => 0.5, ...options });
}

export function graphqlVariables(req: TransportRequest): Record<string, any> {
  if (req.body) return JSON.parse(req.body).variables;
  return JSON.parse(new URL(req.url).searchParams.get('variables')!);
}

/** The listing a StaysPdpSections request asks for, from its variables, or null for any other request. */
export function requestedListing(req: TransportRequest): string | null {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/v3/StaysPdpSections/')) return null;
  const variables = JSON.parse(url.searchParams.get('variables') ?? '{}') as { id?: string };
  const decoded = variables.id ? atob(variables.id) : '';
  return /^StayListing:(\d+)$/.exec(decoded)?.[1] ?? null;
}

const listingFixture = (area: string) =>
  JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/listings/${area}.json.gz`, import.meta.url))).toString()) as {
    recordings: { request: { url: string }; response: { body: string } }[];
  };
const recordedBody = (area: string) => listingFixture(area).recordings.find((r) => r.request.url.includes('/StaysPdpSections/'))!.response.body;

/** A recorded StaysPdpSections response for a real listing. */
export const LISTING_JSON = recordedBody('austin-tx');
/** A recorded StaysPdpSections response for a removed listing: Airbnb's "permission denied" error. */
export const MISSING_LISTING_JSON = recordedBody('missing');
