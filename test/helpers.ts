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
