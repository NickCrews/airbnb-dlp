/**
 * Listing attributes, from the StaysPdpSections query: the GraphQL data the
 * listing page itself loads, at a fraction of the page's size. Fields are
 * found by key name and shape anywhere in the response, not by path, so
 * renamed wrappers and moved sections do not break them.
 */
import { decodeNodeId, graphql, nodeId } from '../airbnb.ts';
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
const SUBTITLE_KEY = /^subtitle$/i;
const VERIFIED_KEY = /^(is)?verified$/i;

function firstKey<T>(obj: Record<string, unknown>, key: RegExp, accept: (v: unknown) => v is T): T | null {
  for (const [k, v] of Object.entries(obj)) if (key.test(k) && accept(v)) return v;
  return null;
}

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** The first boolean under a key like isVerified in the location object, at any depth: the host has its own isVerified elsewhere. */
function nestedVerified(obj: Record<string, unknown>): boolean | null {
  for (const o of objects(obj)) {
    const verified = firstKey(o, VERIFIED_KEY, isBoolean);
    if (verified !== null) return verified;
  }
  return null;
}

interface FoundLocation {
  lat: number | null;
  lng: number | null;
  exact: boolean;
  verified: boolean | null;
  subtitle: string | null;
  address: string | null;
}

/** The location object: the one with a boolean key like isExactLocation. */
function findLocation(docs: unknown[]): FoundLocation | null {
  for (const obj of objects(docs)) {
    const exact = firstKey(obj, EXACT_LOCATION_KEY, isBoolean);
    if (exact === null) continue;
    const subtitle = firstKey(obj, SUBTITLE_KEY, isString)?.trim() || null;
    return {
      exact,
      lat: firstKey(obj, LAT_KEY, isNumber),
      lng: firstKey(obj, LNG_KEY, isNumber),
      verified: nestedVerified(obj),
      subtitle,
      address: firstKey(obj, ADDRESS_KEY, isString),
    };
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
function overviewItems(docs: unknown[]): string[] {
  const lines: string[] = [];
  for (const obj of objects(docs)) {
    const items = obj['items'];
    if (Array.isArray(items) && items.length > 0 && items.every(isString)) lines.push(...items);
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

/** The primary host's account id: the response's one DemandUser id. */
function hostId(docs: unknown[]): string | null {
  const ids = new Set<string>();
  for (const obj of objects(docs)) {
    for (const value of Object.values(obj)) {
      const id = decodeNodeId(value, 'DemandUser');
      if (id) ids.add(id);
    }
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/**
 * The host card: the one object with a timeAsHost key, beside the bio. A card
 * naming another account than the page's host is ignored.
 */
function host(docs: unknown[]): Host | null {
  const id = hostId(docs);
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

/** A listing from a StaysPdpSections response. */
export function parseListing(id: ListingId, response: unknown): Listing {
  const json = [response];
  if (isMissingListing(json)) throw new AirbnbError('NotFound', `listing ${id} is removed or hidden`);

  const location = findLocation(json);
  const lat = location?.lat ?? null;
  const lng = location?.lng ?? null;
  const exact = location?.exact ?? null;

  const roomTypes = distinct(json, 'roomType', isString);
  const roomTypeText = roomTypes.length === 1 ? roomTypes[0]! : (roomTypes.find((t) => t in ROOM_TYPES) ?? null);
  const guestCapacity = only(json, 'personCapacity', isNumber);
  const bedCount = only(json, 'bedCount', isNumber);

  if (lat === null && roomTypeText === null && guestCapacity === null) {
    // Nothing in the response reads as a listing: Airbnb served something else.
    throw new MarkerMissingError('listing response has none of the listing data');
  }
  if (lat === null || lng === null) throw new ShapeError('listing response has no coordinate');

  const lines = [...overviewItems(json), ...sharingTitleItems(json)];
  const bedrooms = pickLine(lines, /\bbedrooms?\b|^\s*studio\s*$/i, (t) => ({ count: parseBedrooms(t) }));
  const bathrooms = pickLine(lines, /\bbath/i, parseBathrooms);
  const bedLine = lines.find((t) => /^\s*\d+\s+beds?\s*$/i.test(t));
  const lineBeds = bedLine ? Number(/\d+/.exec(bedLine)![0]) : null;
  const beds = bedCount ?? lineBeds;

  return {
    id,
    location: { lat, lng, exact, verified: location?.verified ?? null, subtitle: location?.subtitle ?? null },
    address: location?.address ?? null,
    roomType: roomTypeText ? (ROOM_TYPES[roomTypeText] ?? null) : null,
    roomTypeText,
    propertyType: only(json, 'propertyType', (v): v is string => typeof v === 'string' && /^[A-Z][A-Z_]*$/.test(v)),
    guestCapacity,
    beds,
    bedrooms,
    bathrooms,
    registration: registration(json),
    host: host(json),
    photoUrls: photos(json),
  };
}

/** The variables the listing page sends for StaysPdpSections, without dates or guests. */
export function listingVariables(id: ListingId): Record<string, unknown> {
  const flags = {
    includeGpBookItFragment: true,
    includeGpPropertyAvailableRoomsFragment: false,
    includePdpLayoutPipelineInputs: false,
    includePdpMigrationBookItCalendarSheetFragment: true,
    includePdpMigrationBookItFloatingFooterFragment: true,
    includePdpMigrationBookItNavFragment: true,
    includePdpMigrationBookItSidebarFragment: true,
    includePdpMigrationPropertyAvailableRoomsFragment: true,
    includePdpOffers: false,
  };
  return {
    id: nodeId('StayListing', id),
    demandStayListingId: nodeId('DemandStayListing', id),
    ...flags,
    amenityIds: null,
    categoryTag: null,
    causeId: null,
    dateRange: null,
    federatedSearchId: null,
    federatedSearchSessionId: null,
    guestCounts: null,
    numberOfChildren: null,
    numberOfInfants: null,
    numberOfPets: null,
    photoId: null,
    targetPromotion: null,
    pdpSectionsRequest: {
      adults: '1',
      bypassTargetings: false,
      layouts: ['SIDEBAR', 'SINGLE_COLUMN'],
      pets: 0,
      preview: false,
      privateBooking: false,
      staysBookingMigrationEnabled: false,
      useNewSectionWrapperApi: false,
      hostPreview: false,
      logPricingViewEvent: false,
    },
  };
}

export async function fetchListing(call: Call, id: ListingId): Promise<Listing> {
  const { json, result } = await graphql(call, 'StaysPdpSections', listingVariables(id));
  return call.parse(result, () => {
    try {
      return parseListing(id, json);
    } catch (cause) {
      if (cause instanceof AirbnbError) {
        throw new AirbnbError(cause.category, cause.message, { exchange: result.exchange, cause });
      }
      throw cause;
    }
  });
}
