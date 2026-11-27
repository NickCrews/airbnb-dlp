/**
 * How requests to airbnb.com are built: the API key, persisted-query hashes
 * and the GraphQL request shape shared by every product.
 *
 * Airbnb rotates persisted-query hashes. A rotated hash shows up as a
 * RequestRejected failure (HTTP 400, or a PersistedQueryNotFound error). The
 * current hash for an operation appears in the site's JS bundles as
 * `name:'<Operation>',type:'query',operationId:'<hash>'`.
 */
import type { Call, FetchResult } from './call.ts';
import { AirbnbError } from './errors.ts';
import { MarkerMissingError, ShapeError } from './parse-errors.ts';
import type { TransportRequest } from './types.ts';
import { HTML_HEADERS, JSON_HEADERS, LOCALE, ORIGIN } from './identity.ts';

export { ORIGIN, LOCALE } from './identity.ts';

export const OPERATIONS = {
  StaysSearch: 'aec09eb74dbd01c4019adbb6b4fcc3cc2ca224457ebcc3a2219bb4f4f5c8f206',
  PdpAvailabilityCalendarV2Query: '4d4724885b57d91f65be3c50c8b792b92a0dc723a871affb6ee358a0caf6d694',
  StaysPdpBookItQuery: '9afe04ccb0e7082750ec50fb56513196422b992449bb0406c3dffcc954863b68',
  StaysPdpReviewsQuery: 'cfdc3ffbe997a618795fc5a8f9a9b484054ce9be68c8788cd2ffda999934c5ae',
  StaysPdpSections: '498f49182b98f0b3989f4ec57edfd180ad50b0d7422b12d5c4959b67bb12f059',
} as const;
export type Operation = keyof typeof OPERATIONS;

export function htmlRequest(url: string): TransportRequest {
  return { method: 'GET', url, headers: { ...HTML_HEADERS }, body: null };
}

/** base64 of `<type>:<id>`, Airbnb's GraphQL node id. */
export function nodeId(type: 'DemandStayListing' | 'StayListing', id: string): string {
  return btoa(`${type}:${id}`);
}

/** Decodes a base64 node id such as `DemandStayListing:123` or `DemandUser:456` to its number, or null. */
export function decodeNodeId(encoded: unknown, type?: string): string | null {
  if (typeof encoded !== 'string' || encoded === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):(\d+)$/.exec(decoded);
  if (!match) return null;
  if (type !== undefined && match[1] !== type) return null;
  return match[2]!;
}

const API_KEY_RE = /"api_config":\{"key":"([^"]+)"/;

export function parseApiKey(html: string): string {
  const match = API_KEY_RE.exec(html);
  if (!match) throw new MarkerMissingError('homepage has no api_config key');
  return match[1]!;
}

/** The public web API key, read from the homepage once per client and shared by its calls. */
export async function apiKey(call: Call): Promise<string> {
  const state = call.ctx.apiKey;
  if (state.value) return state.value;
  if (state.pending) {
    try {
      return await state.pending;
    } catch {
      // The call that started the fetch failed; fetch again under this call's budget.
    }
  }
  const pending = (async () => {
    const result = await call.fetch(htmlRequest(`${ORIGIN}/?locale=${LOCALE}`));
    return call.parse(result, parseApiKey);
  })();
  state.pending = pending;
  try {
    state.value = await pending;
    return state.value;
  } finally {
    if (state.pending === pending) state.pending = null;
  }
}

function graphqlUrl(operation: Operation, currency: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ operationName: operation, locale: LOCALE, currency, ...query });
  return `${ORIGIN}/api/v3/${operation}/${OPERATIONS[operation]}?${params}`;
}

function extensions(operation: Operation): { persistedQuery: { version: 1; sha256Hash: string } } {
  return { persistedQuery: { version: 1, sha256Hash: OPERATIONS[operation] } };
}

/** Sends one persisted GraphQL query and returns its parsed JSON body. */
export async function graphql(
  call: Call,
  operation: Operation,
  variables: Record<string, unknown>,
  method: 'GET' | 'POST' = 'GET',
): Promise<{ json: unknown; result: FetchResult }> {
  const key = await apiKey(call);
  const headers = { ...JSON_HEADERS, 'X-Airbnb-Api-Key': key };
  const currency = call.ctx.currency;
  const request: TransportRequest =
    method === 'GET'
      ? {
          method,
          url: graphqlUrl(operation, currency, {
            variables: JSON.stringify(variables),
            extensions: JSON.stringify(extensions(operation)),
          }),
          headers,
          body: null,
        }
      : {
          method,
          url: graphqlUrl(operation, currency),
          headers,
          body: JSON.stringify({ operationName: operation, extensions: extensions(operation), variables }),
        };
  const result = await call.fetch(request);
  const json = call.parse(result, parseGraphqlBody);
  const errors = (json as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.map((e) => String((e as { message?: unknown })?.message ?? '?')).join('; ');
    // A removed or hidden listing is refused at the node lookup.
    const category = /permission denied for id .* path: \/node\b/i.test(messages) ? 'NotFound' : 'RequestRejected';
    throw new AirbnbError(category, `${operation} returned errors: ${messages}`, {
      exchange: result.exchange,
    });
  }
  return { json, result };
}

/** A GraphQL body must be JSON; an HTML page in its place is a bot page. */
export function parseGraphqlBody(body: string): unknown {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{')) throw new MarkerMissingError('GraphQL response is not JSON');
  const json: unknown = JSON.parse(trimmed);
  if (typeof json !== 'object' || json === null) throw new ShapeError('GraphQL response is not an object');
  return json;
}
