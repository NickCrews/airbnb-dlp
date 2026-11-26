/**
 * Listing attributes, from the listing page's embedded GraphQL state
 * (`<script id="data-deferred-state-0">`). Fields are found by key name and
 * shape anywhere in the tree, since Airbnb moves objects between sections.
 */
import { ORIGIN, decodeNodeId, htmlRequest } from '../airbnb.ts';
import type { Call } from '../call.ts';
import { AirbnbError } from '../errors.ts';
import { MarkerMissingError, ShapeError } from '../parse-errors.ts';
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  distinct,
  isNumber,
  isRecord,
  isString,
  objects,
  only,
} from '../json.ts';
import type { Host, Listing, ListingId, RoomType } from '../types.ts';

export const ROOM_TYPES: Record<string, RoomType> = {
  'Entire home/apt': 'entire_home',
  'Private room': 'private_room',
  'Shared room': 'shared_room',
  'Hotel room': 'hotel_room',
};

export function listingPageUrl(id: ListingId, query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ locale: 'en', ...query });
  return `${ORIGIN}/rooms/${id}?${params}`;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * The page's embedded data: the GraphQL state in `data-deferred-state-0`, plus
 * the other JSON scripts, which carry fields such as bedCount. Throws
 * MarkerMissingError when the page has no GraphQL state.
 */
export function pageState(html: string): unknown[] {
  let state: unknown[] | null = null;
  const extra: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_RE)) {
    const attrs = match[1]!;
    const text = match[2]!;
    if (/\bid="data-deferred-state-0"/.test(attrs)) {
      const client = asArray(asRecord(JSON.parse(text))['niobeClientData']);
      if (client.length === 0) throw new ShapeError('page state has no niobeClientData');
      state = client;
    } else if (/type="application\/json"/.test(attrs) && text.trimStart().startsWith('{')) {
      try {
        extra.push(JSON.parse(text));
      } catch {
        // A script that is not JSON carries nothing the parser reads.
      }
    }
  }
  if (!state) throw new MarkerMissingError('page has no data-deferred-state-0 script');
  return [state, ...extra];
}

/** True when the page state says the listing does not exist or is hidden. */
export function isMissingListing(state: unknown): boolean {
  for (const obj of objects(state)) {
    const redirect = asString(asRecord(obj['errorData'])['redirectUrl']);
    if (redirect && /\/404\b/.test(redirect)) return true;
  }
  return false;
}

function findLocation(state: unknown): Record<string, unknown> | null {
  for (const obj of objects(state)) {
    if (typeof obj['isExactLocation'] === 'boolean' && isNumber(obj['latitude']) && isNumber(obj['longitude'])) {
      return obj;
    }
  }
  return null;
}

/** "3 bedrooms" is 3, "1 bedroom" is 1, "Studio" is 0. */
export function parseBedrooms(text: string): number | null {
  if (/^\s*studio\s*$/i.test(text)) return 0;
  const m = /^\s*(\d+(?:\.\d+)?)\s+bedrooms?\s*$/i.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * "1.5 shared baths" is { count: 1.5, access: 'shared' }, "Half-bath" counts 0.5,
 * "No bathroom" is 0, "Shared bathroom" has a null count, a bare "N baths" is private.
 */
export function parseBathrooms(text: string): { count: number | null; access: 'private' | 'dedicated' | 'shared' | null } {
  const t = text.trim().toLowerCase();
  if (/^no bath(room)?s?$/.test(t)) return { count: 0, access: null };
  const half = /^(private |dedicated |shared )?half-bath$/.exec(t);
  if (half) return { count: 0.5, access: accessOf(half[1]) ?? 'private' };
  const counted = /^(\d+(?:\.\d+)?)\s+(private |dedicated |shared )?(bath|baths|bathroom|bathrooms)$/.exec(t);
  if (counted) return { count: Number(counted[1]), access: accessOf(counted[2]) ?? 'private' };
  const bare = /^(private|dedicated|shared)(?: attached)? (bath|bathroom)$/.exec(t);
  if (bare) return { count: null, access: accessOf(`${bare[1]} `) };
  return { count: null, access: null };
}

function accessOf(word: string | undefined): 'private' | 'dedicated' | 'shared' | null {
  const w = word?.trim();
  return w === 'private' || w === 'dedicated' || w === 'shared' ? w : null;
}

function overviewItems(state: unknown): string[] {
  for (const obj of objects(state)) {
    if (obj['__typename'] === 'StaysPdpOverview') return asArray(obj['items']).filter(isString);
  }
  return [];
}

function registration(state: unknown): string | null {
  for (const obj of objects(state)) {
    if (typeof obj['title'] === 'string' && /registration/i.test(obj['title'])) {
      const text = asString(asRecord(obj['html'])['htmlText']) ?? asString(obj['subtitle']);
      if (text) return htmlToText(text);
    }
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function host(state: unknown): Host | null {
  const ids = new Set<string>();
  for (const obj of objects(state)) {
    for (const value of Object.values(obj)) {
      const id = decodeNodeId(value, 'DemandUser');
      if (id) ids.add(id);
    }
  }
  for (const obj of objects(state)) {
    const passport = obj['passportData'];
    if (!isRecord(passport) || !('about' in obj)) continue;
    const id = decodeNodeId(passport['userId'], 'DemandUser');
    if (!id) continue;
    const about = obj['about'];
    const time = asRecord(passport['timeAsHost']);
    const years = asNumber(time['years']);
    const months = asNumber(time['months']);
    return {
      id,
      name: asString(passport['name']),
      about: isRecord(about)
        ? (asString(about['source']) ?? asString(about['localizedString']) ?? asString(about['localizedStringWithTranslationPreference']))
        : null,
      timeAsHost: years !== null && months !== null ? { years, months } : null,
    };
  }
  if (ids.size === 1) {
    return { id: [...ids][0]!, name: null, about: null, timeAsHost: null };
  }
  return null;
}

/** The longest media tour, in the host's order. Hero media is reordered for the header collage. */
function photos(state: unknown): string[] {
  let best: string[] = [];
  for (const obj of objects(state)) {
    const tour = obj['mediaTour'];
    if (!isRecord(tour)) continue;
    const urls: string[] = [];
    for (const stop of asArray(tour['stops'])) {
      for (const item of asArray(asRecord(stop)['items'])) {
        const uri = asString(asRecord(asRecord(item)['image'])['uri']);
        if (uri?.startsWith('https://') && !urls.includes(uri)) urls.push(uri);
      }
    }
    if (urls.length > best.length) best = urls;
  }
  return best;
}

/** "Room in Hilo · ★4.96 · 1 bedroom · 1 bed · 1.5 private baths" as its parts. */
function sharingTitleItems(state: unknown): string[] {
  for (const obj of objects(state)) {
    if (obj['__typename'] === 'PdpSharingConfig' && typeof obj['title'] === 'string') {
      return obj['title'].split(' · ').map((t) => t.trim());
    }
  }
  return [];
}

/** The first matching line whose count parses, else the first matching line. */
function pickLine<T extends { count: number | null }>(lines: string[], match: RegExp, parse: (t: string) => T): (T & { text: string }) | null {
  const candidates = lines.filter((t) => match.test(t)).map((text) => ({ ...parse(text), text }));
  return candidates.find((c) => c.count !== null) ?? candidates[0] ?? null;
}

export function parseListingPage(id: ListingId, html: string): Listing {
  const trees = pageState(html);
  const state = trees[0];
  if (isMissingListing(state)) throw new AirbnbError('NotFound', `listing ${id} is removed or hidden`);
  const location = findLocation(state);
  if (!location) throw new ShapeError('listing page has no location object');

  const roomTypes = distinct(state, 'roomType', isString);
  const roomTypeText = roomTypes.find((t) => t in ROOM_TYPES) ?? roomTypes[0] ?? null;
  const lines = [...overviewItems(state), ...sharingTitleItems(state)];
  const bedrooms = pickLine(lines, /\bbedrooms?\b|^\s*studio\s*$/i, (t) => ({ count: parseBedrooms(t) }));
  const bathrooms = pickLine(lines, /\bbath/i, parseBathrooms);
  const bedLine = lines.find((t) => /^\s*\d+\s+beds?\s*$/i.test(t));
  const beds = only(trees, 'bedCount', isNumber) ?? (bedLine ? Number(/\d+/.exec(bedLine)![0]) : null);

  return {
    id,
    location: {
      lat: location['latitude'] as number,
      lng: location['longitude'] as number,
      exact: asBoolean(location['isExactLocation']),
    },
    address: asString(location['exactAddress']),
    roomType: roomTypeText ? (ROOM_TYPES[roomTypeText] ?? null) : null,
    propertyType: only(state, 'propertyType', (v): v is string => typeof v === 'string' && /^[A-Z][A-Z_]*$/.test(v)),
    guestCapacity: only(state, 'personCapacity', isNumber),
    beds,
    bedrooms,
    bathrooms,
    registration: registration(state),
    host: host(state),
    photoUrls: photos(state),
  };
}

export async function fetchListing(call: Call, id: ListingId): Promise<Listing> {
  const result = await call.fetch(htmlRequest(listingPageUrl(id)), [404, 410]);
  if (result.response.status === 404 || result.response.status === 410) {
    throw new AirbnbError('NotFound', `listing ${id} is removed or hidden`, { exchange: result.exchange });
  }
  return call.parse(result, (body) => {
    try {
      return parseListingPage(id, body);
    } catch (cause) {
      if (cause instanceof AirbnbError) {
        throw new AirbnbError(cause.category, cause.message, { exchange: result.exchange, cause });
      }
      throw cause;
    }
  });
}
