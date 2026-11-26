/**
 * Listing attributes, from the listing page. The page is not a documented API,
 * so each field is read in up to three independent ways, and a change to one
 * leaves the others working:
 *
 * 1. the embedded GraphQL state, in every JSON script on the page. Fields are
 *    found by key name and shape anywhere in the tree, not by path, so renamed
 *    wrappers and moved sections do not break them;
 * 2. the schema.org JSON-LD block, for the coordinate;
 * 3. patterns over the raw HTML, for when the JSON does not parse. A pattern
 *    yields nothing when it matches more than one distinct value.
 */
import { ORIGIN, decodeNodeId, htmlRequest } from '../airbnb.ts';
import type { Call } from '../call.ts';
import { AirbnbError } from '../errors.ts';
import { MarkerMissingError, ShapeError } from '../parse-errors.ts';
import { asArray, asNumber, asRecord, asString, distinct, isNumber, isRecord, isString, objects, only } from '../json.ts';
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

export interface PageDocs {
  /** Every JSON script that parses, largest first: the GraphQL state is the largest. */
  json: unknown[];
  /** schema.org JSON-LD blocks. */
  jsonLd: unknown[];
}

export function pageDocs(html: string): PageDocs {
  const json: { size: number; doc: unknown }[] = [];
  const jsonLd: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_RE)) {
    const attrs = match[1]!;
    const text = match[2]!;
    const isLd = /type="application\/ld\+json"/i.test(attrs);
    if (!isLd && !/type="[^"]*json[^"]*"/i.test(attrs) && !text.trimStart().startsWith('{')) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    if (isLd) jsonLd.push(doc);
    else json.push({ size: text.length, doc });
  }
  json.sort((x, y) => y.size - x.size);
  return { json: json.map((j) => j.doc), jsonLd };
}

/** The one distinct capture of a global pattern in the raw document, or null. */
function soleMatch(html: string, pattern: RegExp): string | null {
  const values = new Set<string>();
  for (const m of html.matchAll(pattern)) values.add(m[1]!);
  return values.size === 1 ? [...values][0]! : null;
}

const RAW = {
  exactLocation: /"\w*[eE]xact[lL]ocation\w*"\s*:\s*(true|false)/g,
  roomType: /"roomType"\s*:\s*"([^"]+)"/g,
  personCapacity: /"personCapacity"\s*:\s*(\d+)/g,
  bedCount: /"bedCount"\s*:\s*(\d+)/g,
  hostId: /"host_?id"\s*:\s*"?(\d+)/gi,
  items: /"items"\s*:\s*(\["(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*\])/g,
};

/** True when the page state says the listing does not exist or is hidden. */
export function isMissingListing(state: unknown): boolean {
  for (const obj of objects(state)) {
    const redirect = asString(asRecord(obj['errorData'])['redirectUrl']);
    if (redirect && /\/404\b/.test(redirect)) return true;
  }
  return false;
}

const EXACT_LOCATION_KEY = /exact.*location/i;
const LAT_KEY = /^lat(itude)?$/i;
const LNG_KEY = /^(lng|long|longitude)$/i;
const ADDRESS_KEY = /^exact.*address$/i;

function firstKey<T>(obj: Record<string, unknown>, key: RegExp, accept: (v: unknown) => v is T): T | null {
  for (const [k, v] of Object.entries(obj)) if (key.test(k) && accept(v)) return v;
  return null;
}

/** The location object: the one with a boolean key like isExactLocation. */
function findLocation(docs: unknown[]): { lat: number | null; lng: number | null; exact: boolean; address: string | null } | null {
  for (const obj of objects(docs)) {
    const exact = firstKey(obj, EXACT_LOCATION_KEY, (v): v is boolean => typeof v === 'boolean');
    if (exact === null) continue;
    return {
      exact,
      lat: firstKey(obj, LAT_KEY, isNumber),
      lng: firstKey(obj, LNG_KEY, isNumber),
      address: firstKey(obj, ADDRESS_KEY, isString),
    };
  }
  return null;
}

function jsonLdCoordinate(docs: unknown[]): { lat: number; lng: number } | null {
  for (const obj of objects(docs)) {
    if (isNumber(obj['latitude']) && isNumber(obj['longitude'])) return { lat: obj['latitude'], lng: obj['longitude'] };
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

/** Every overview-style list of strings, such as ["5 guests", "2 bedrooms", "3 beds", "1 bath"]. */
function overviewItems(docs: unknown[], html: string): string[] {
  const lines: string[] = [];
  for (const obj of objects(docs)) {
    const items = obj['items'];
    if (Array.isArray(items) && items.length > 0 && items.every(isString)) lines.push(...items);
  }
  if (lines.length > 0) return lines;
  for (const m of html.matchAll(RAW.items)) {
    try {
      lines.push(...(JSON.parse(m[1]!) as string[]));
    } catch {
      // An unparseable list carries nothing to read.
    }
  }
  return lines;
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

const TIME_AS_HOST_KEY = /^time_?as_?host$/i;

/** The primary host's account id: the page's one DemandUser id, else the analytics hostId. */
function hostId(docs: unknown[], html: string): string | null {
  const ids = new Set<string>();
  for (const obj of objects(docs)) {
    for (const value of Object.values(obj)) {
      const id = decodeNodeId(value, 'DemandUser');
      if (id) ids.add(id);
    }
  }
  if (ids.size === 1) return [...ids][0]!;
  if (ids.size > 1) return null;
  return soleMatch(html, RAW.hostId);
}

/**
 * The host card: the one object with a timeAsHost key, beside the bio. A card
 * naming another account than the page's host is ignored.
 */
function host(docs: unknown[], html: string): Host | null {
  const id = hostId(docs, html);
  if (!id) return null;
  for (const obj of objects(docs)) {
    for (const card of Object.values(obj)) {
      if (!isRecord(card) || !Object.keys(card).some((k) => TIME_AS_HOST_KEY.test(k))) continue;
      const cardId = decodeNodeId(firstKey(card, /^user_?id$/i, isString), 'DemandUser');
      if (cardId !== id) continue;
      const time = asRecord(firstKey(card, TIME_AS_HOST_KEY, isRecord));
      const years = asNumber(time['years']);
      const months = asNumber(time['months']);
      const about = obj['about'];
      return {
        id,
        name: asString(card['name']),
        about: isRecord(about)
          ? (asString(about['source']) ?? asString(about['localizedString']) ?? asString(about['localizedStringWithTranslationPreference']))
          : null,
        timeAsHost: years !== null && months !== null ? { years, months } : null,
      };
    }
  }
  return { id, name: null, about: null, timeAsHost: null };
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
  const candidates = [...new Set(lines)].filter((t) => match.test(t)).map((text) => ({ ...parse(text), text }));
  return candidates.find((c) => c.count !== null) ?? candidates[0] ?? null;
}

export function parseListingPage(id: ListingId, html: string): Listing {
  const { json, jsonLd } = pageDocs(html);
  if (isMissingListing(json)) throw new AirbnbError('NotFound', `listing ${id} is removed or hidden`);

  const location = findLocation(json);
  const ld = jsonLdCoordinate(jsonLd);
  const rawExact = soleMatch(html, RAW.exactLocation);
  const lat = location?.lat ?? ld?.lat ?? null;
  const lng = location?.lng ?? ld?.lng ?? null;
  const exact = location?.exact ?? (rawExact === null ? null : rawExact === 'true');

  const roomTypes = distinct(json, 'roomType', isString);
  const roomTypeText = roomTypes.length === 1 ? roomTypes[0]! : roomTypes.find((t) => t in ROOM_TYPES) ?? soleMatch(html, RAW.roomType);
  const rawNumber = (pattern: RegExp) => {
    const v = soleMatch(html, pattern);
    return v === null ? null : Number(v);
  };
  const guestCapacity = only(json, 'personCapacity', isNumber) ?? rawNumber(RAW.personCapacity);
  const bedCount = only(json, 'bedCount', isNumber) ?? rawNumber(RAW.bedCount);

  if (lat === null && roomTypeText === null && guestCapacity === null) {
    // Nothing on the page reads as a listing: Airbnb served something else.
    throw new MarkerMissingError('listing page has none of the listing data markers');
  }
  if (lat === null || lng === null) throw new ShapeError('listing page has no coordinate');

  const lines = [...overviewItems(json, html), ...sharingTitleItems(json)];
  const bedrooms = pickLine(lines, /\bbedrooms?\b|^\s*studio\s*$/i, (t) => ({ count: parseBedrooms(t) }));
  const bathrooms = pickLine(lines, /\bbath/i, parseBathrooms);
  const bedLine = lines.find((t) => /^\s*\d+\s+beds?\s*$/i.test(t));
  const lineBeds = bedLine ? Number(/\d+/.exec(bedLine)![0]) : null;
  const beds = bedCount ?? lineBeds;

  return {
    id,
    location: { lat, lng, exact },
    address: location?.address ?? null,
    roomType: roomTypeText ? (ROOM_TYPES[roomTypeText] ?? null) : null,
    propertyType: only(json, 'propertyType', (v): v is string => typeof v === 'string' && /^[A-Z][A-Z_]*$/.test(v)),
    guestCapacity,
    beds,
    bedrooms,
    bathrooms,
    registration: registration(json),
    host: host(json, html),
    photoUrls: photos(json),
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
