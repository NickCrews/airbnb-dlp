/**
 * Complete search: every listing matching a query, however many there are.
 *
 * One StaysSearch request returns at most one page of 40 listings, and a
 * result set stops at about 280 even when more match. Following cursors does
 * not help: Airbnb re-ranks results between page requests, so paging drops
 * and repeats listings. Instead each query is split into price bands and,
 * where one price band is still too dense, into smaller boxes, until every
 * piece fits on a single page. Only single-page pieces are read.
 */
import { decodeNodeId, graphql } from '../airbnb.ts';
import type { Call, ClientContext } from '../call.ts';
import { toAirbnbError } from '../call.ts';
import { dayNumber } from '../dates.ts';
import { AirbnbError } from '../errors.ts';
import { ShapeError } from '../parse-errors.ts';
import { asArray, asNumber, asRecord, asString, dig, isString, parseAmount } from '../json.ts';
import { AMENITIES, PROPERTY_GROUP_IDS } from '../reference.ts';
import type { BBox, SearchHit, SearchListing, SearchQuery } from '../types.ts';

/** Seed price bands, per night; null is open-ended. Dense bands are split further. */
export const PRICE_SEEDS: [number, number | null][] = [
  [0, 50], [50, 75], [75, 100], [100, 125], [125, 150], [150, 175], [175, 200],
  [200, 250], [250, 300], [300, 500], [500, 1000], [1000, null],
];
/** A band this narrow is split by area instead. */
export const MIN_PRICE_BAND = 1;
/** A box with both sides this short is not split further. */
export const MIN_BOX_SIDE_KM = 0.5;

const TREATMENT_FLAGS = [
  'feed_map_decouple_m11_treatment',
  'stays_search_rehydration_treatment_desktop',
  'stays_search_rehydration_treatment_moweb',
  'selective_query_feed_map_homepage_desktop_treatment',
  'selective_query_feed_map_homepage_moweb_treatment',
];

/** One piece of a query: a box (not crossing the antimeridian) and a price band. */
export interface Cell {
  box: BBox;
  min: number;
  max: number | null;
}

export interface SearchPage {
  listings: SearchListing[];
  pageCount: number;
  /** Airbnb's count of all matches, beyond the page. */
  resultCount: number | null;
  bounds: BBox | null;
}

// ---------------------------------------------------------------- geometry

/** Splits a box crossing the antimeridian (west > east) into two that do not. */
export function unwrapBox(box: BBox): BBox[] {
  if (box.west <= box.east) return [box];
  return [
    { ...box, east: 180 },
    { ...box, west: -180 },
  ];
}

export function boxSidesKm(box: BBox): { ns: number; ew: number } {
  const midLat = ((box.north + box.south) / 2) * (Math.PI / 180);
  return {
    ns: (box.north - box.south) * 111.32,
    ew: (box.east - box.west) * 111.32 * Math.cos(midLat),
  };
}

/** Halves a box across its longer side. Null when both sides are already short. */
export function splitBox(box: BBox): [BBox, BBox] | null {
  const { ns, ew } = boxSidesKm(box);
  if (ns <= MIN_BOX_SIDE_KM && ew <= MIN_BOX_SIDE_KM) return null;
  if (ew >= ns) {
    const mid = (box.west + box.east) / 2;
    return [
      { ...box, east: mid },
      { ...box, west: mid },
    ];
  }
  const mid = (box.south + box.north) / 2;
  return [
    { ...box, north: mid },
    { ...box, south: mid },
  ];
}

/** Whether a point is inside a box, which may cross the antimeridian. */
export function inBox(box: BBox, lat: number, lng: number): boolean {
  if (lat < box.south || lat > box.north) return false;
  return box.west <= box.east ? lng >= box.west && lng <= box.east : lng >= box.west || lng <= box.east;
}

/** Listings a piece should expect at most, below the 40 a page holds, so most pieces fit on their first try. */
export const TARGET_PER_PIECE = 30;

/**
 * Splits a price band into pieces of equal width, enough that each holds about
 * TARGET_PER_PIECE of `count` listings; halves it when the count is unknown.
 * `price_max=X` and `price_min=X` are complementary, so pieces that share a
 * boundary neither overlap nor leave a gap. Null when the band is already one
 * unit wide. An open-ended band splits off one bounded piece.
 */
export function splitBand(min: number, max: number | null, count: number | null = null): [number, number | null][] | null {
  if (max === null) {
    const mid = Math.max(min * 2, min + 100);
    return [
      [min, mid],
      [mid, null],
    ];
  }
  const width = max - min;
  if (width <= MIN_PRICE_BAND) return null;
  const wanted = count === null ? 2 : Math.ceil(count / TARGET_PER_PIECE);
  const pieces = Math.max(2, Math.min(wanted, 16, Math.floor(width / MIN_PRICE_BAND)));
  const edges = Array.from({ length: pieces + 1 }, (_, i) => (i === pieces ? max : min + Math.floor((width * i) / pieces)));
  const bands: [number, number | null][] = [];
  for (let i = 0; i < pieces; i++) if (edges[i + 1]! > edges[i]!) bands.push([edges[i]!, edges[i + 1]!]);
  return bands;
}

/** The seed bands clipped to the query's own price range. */
export function seedBands(range: SearchQuery['nightlyPrice']): [number, number | null][] {
  const lo = range?.min ?? 0;
  const hi = range?.max ?? null;
  const bands: [number, number | null][] = [];
  for (const [min, max] of PRICE_SEEDS) {
    const a = Math.max(min, lo);
    const b = max === null ? hi : hi === null ? max : Math.min(max, hi);
    if (b !== null && b <= a) continue;
    bands.push([a, b]);
  }
  return bands;
}

// ---------------------------------------------------------------- request

type RawParam = { filterName: string; filterValues: string[] };

export function rawParams(query: SearchQuery, cell: Cell | null): RawParam[] {
  const params: [string, string[]][] = [
    ['cdnCacheSafe', ['false']],
    ['channel', ['EXPLORE']],
    ['datePickerType', ['calendar']],
    ['itemsPerGrid', ['50']],
    ['priceFilterInputType', ['0']],
    ['refinementPaths', ['/homes']],
    ['screenSize', ['large']],
    ['tabId', ['home_tab']],
    ['version', ['1.8.3']],
  ];
  if (cell) {
    params.push(
      ['neLat', [String(cell.box.north)]],
      ['neLng', [String(cell.box.east)]],
      ['swLat', [String(cell.box.south)]],
      ['swLng', [String(cell.box.west)]],
      ['searchByMap', ['true']],
      ['zoomLevel', ['11']],
      ['query', ['']],
    );
    if (cell.min > 0) params.push(['price_min', [String(cell.min)]]);
    if (cell.max !== null) params.push(['price_max', [String(cell.max)]]);
  } else if ('place' in query.area) {
    params.push(['query', [query.area.place]]);
    if (query.nightlyPrice?.min !== undefined) params.push(['price_min', [String(query.nightlyPrice.min)]]);
    if (query.nightlyPrice?.max !== undefined) params.push(['price_max', [String(query.nightlyPrice.max)]]);
  }
  if (query.stay) {
    const nights = dayNumber(query.stay.checkOut) - dayNumber(query.stay.checkIn);
    params.push(['checkin', [query.stay.checkIn]], ['checkout', [query.stay.checkOut]]);
    params.push(['priceFilterNumNights', [String(nights)]]);
  } else {
    // Without dates Airbnb prices a stay it picks, and the price filter follows that
    // stay. Left to itself it picks 1, 2 or 5 nights per request, so price bands
    // shift between requests; a one-week trip length pins it to the same stay.
    params.push(['flexibleTripLengths', ['one_week']]);
  }
  const g = query.guests;
  if (g?.adults !== undefined) params.push(['adults', [String(g.adults)]]);
  if (g?.children !== undefined) params.push(['children', [String(g.children)]]);
  if (g?.infants !== undefined) params.push(['infants', [String(g.infants)]]);
  if (g?.pets !== undefined) params.push(['pets', [String(g.pets)]]);
  if (query.minBedrooms !== undefined) params.push(['minBedrooms', [String(query.minBedrooms)]]);
  if (query.minBeds !== undefined) params.push(['minBeds', [String(query.minBeds)]]);
  if (query.minBathrooms !== undefined) params.push(['minBathrooms', [String(query.minBathrooms)]]);
  if (query.propertyGroups?.length) {
    params.push(['l2PropertyTypeIds', query.propertyGroups.map((p) => String(PROPERTY_GROUP_IDS[p]))]);
  }
  if (query.amenities?.length) {
    params.push(['amenities', query.amenities.map((a) => {
      const id = AMENITIES[a];
      if (id === undefined) throw new AirbnbError('RequestRejected', `unknown amenity: ${a}`);
      return String(id);
    })]);
  }
  if (query.instantBook) params.push(['ib', ['true']]);
  return params.map(([filterName, filterValues]) => ({ filterName, filterValues }));
}

export function searchVariables(query: SearchQuery, cell: Cell | null): Record<string, unknown> {
  const request = {
    cursor: '',
    requestedPageType: 'STAYS_SEARCH',
    metadataOnly: false,
    source: 'structured_search_input_header',
    searchType: cell ? 'user_map_move' : 'autocomplete_click',
    treatmentFlags: TREATMENT_FLAGS,
    rawParams: rawParams(query, cell),
  };
  return {
    skipExtendedSearchParams: false,
    includeMapResults: true,
    isLeanTreatment: false,
    aiSearchEnabled: false,
    staysMapSearchRequestV2: request,
    staysSearchRequest: { ...request, maxMapItems: 9999 },
  };
}

// ---------------------------------------------------------------- response

/** "4.96 (50)" is { rating: 4.96, reviewCount: 50 }; a bare "4.96" has no count. */
export function parseRating(raw: unknown): { rating: number | null; reviewCount: number | null } {
  if (typeof raw !== 'string') return { rating: null, reviewCount: null };
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:\((\d[\d,]*)\))?\s*$/.exec(raw);
  if (!m) return { rating: null, reviewCount: null };
  return {
    rating: Number(m[1]!.replace(',', '.')),
    reviewCount: m[2] ? Number(m[2].replaceAll(',', '')) : null,
  };
}

/** "4.89 out of 5 average rating,  294 reviews" is 294. */
export function parseReviewCountLabel(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /(\d[\d,]*)\s+reviews?\b/i.exec(raw);
  return m ? Number(m[1]!.replaceAll(',', '')) : null;
}

export function parseSearchListing(result: unknown, currency: string): SearchListing | null {
  const r = asRecord(result);
  if (r['__typename'] !== 'StaySearchResult') return null;
  const id = decodeNodeId(dig(r, 'demandStayListing.id'));
  if (!id) return null;
  const lat = asNumber(dig(r, 'demandStayListing.location.coordinate.latitude'));
  const lng = asNumber(dig(r, 'demandStayListing.location.coordinate.longitude'));
  const { rating, reviewCount: shownCount } = parseRating(r['avgRatingLocalized']);
  const reviewCount = shownCount ?? parseReviewCountLabel(r['avgRatingA11yLabel']);
  const sdp = asRecord(r['structuredDisplayPrice']);
  const line = asRecord(sdp['primaryLine']);
  let price: SearchListing['price'] = null;
  if (Object.keys(sdp).length > 0) {
    const totalAmount =
      parseAmount(line['discountedPrice']) ??
      parseAmount(line['price']) ??
      asArray(line['orderedComponents']).map((c) => parseAmount(asRecord(c)['discountedPrice']) ?? parseAmount(asRecord(c)['price'])).find((x) => x !== null) ??
      null;
    let nights: number | null = null;
    let nightly: number | null = null;
    const first = asString(dig(sdp, 'explanationData.priceDetails.0.items.0.description'));
    const m = first ? /^(\d+)\s+nights?\s+x\s+(.+)$/i.exec(first) : null;
    if (m) {
      nights = Number(m[1]);
      nightly = parseAmount(m[2]);
    } else {
      const q = asString(line['qualifier']);
      const qm = q ? /for\s+(\d+)\s+nights?/i.exec(q) : null;
      if (qm) nights = Number(qm[1]);
    }
    price = {
      total: totalAmount === null ? null : { amount: totalAmount, currency },
      nights,
      nightly: nightly === null ? null : { amount: nightly, currency },
    };
  }
  return {
    id,
    name: asString(dig(r, 'demandStayListing.description.name.localizedStringWithTranslationPreference')),
    location: lat !== null && lng !== null ? { lat, lng } : null,
    rating,
    reviewCount,
    badges: asArray(r['badges'])
      .map((b) => asString(dig(b, 'loggingContext.badgeType')))
      .filter(isString),
    price,
  };
}

function parseBounds(results: unknown): BBox | null {
  const hint = asRecord(dig(results, 'mapResults.mapMetadata.mapBoundsHint'));
  const north = asNumber(dig(hint, 'northeast.latitude'));
  const east = asNumber(dig(hint, 'northeast.longitude'));
  const south = asNumber(dig(hint, 'southwest.latitude'));
  const west = asNumber(dig(hint, 'southwest.longitude'));
  if (north === null || east === null || south === null || west === null) return null;
  return { north, east, south, west };
}

export function parseSearchPage(json: unknown, currency: string): SearchPage {
  const search = dig(json, 'data.presentation.staysSearch');
  const results = asRecord(search)['results'];
  if (typeof results !== 'object' || results === null) throw new ShapeError('search response has no staysSearch.results');
  const list = asRecord(results)['searchResults'];
  if (!Array.isArray(list)) throw new ShapeError('search response has no searchResults list');
  const listings: SearchListing[] = [];
  for (const r of list) {
    const listing = parseSearchListing(r, currency);
    if (listing) listings.push(listing);
  }
  return {
    listings,
    pageCount: asArray(dig(results, 'paginationInfo.pageCursors')).length,
    resultCount: asNumber(dig(results, 'filters.filterPanel.resultCount')),
    bounds: parseBounds(search),
  };
}

async function fetchPage(call: Call, query: SearchQuery, cell: Cell | null): Promise<SearchPage> {
  const { json, result } = await graphql(call, 'StaysSearch', searchVariables(query, cell), 'POST');
  try {
    return parseSearchPage(json, call.ctx.currency);
  } catch (cause) {
    throw call.parseError(cause, result.exchange);
  }
}

// ---------------------------------------------------------------- driver

/**
 * Runs one query to completion, emitting each listing once. Returns why the
 * query is incomplete, or null when every piece fit on one page.
 */
export async function runSearch(
  ctx: ClientContext,
  call: Call,
  query: SearchQuery,
  emit: (hit: SearchHit) => Promise<void>,
): Promise<AirbnbError | null> {
  const seen = new Set<string>();
  let incomplete: AirbnbError | null = null;
  const note = (error: AirbnbError) => {
    incomplete ??= error;
  };
  const filterBox = 'bbox' in query.area ? query.area.bbox : null;

  const yieldPage = async (page: SearchPage) => {
    for (const listing of page.listings) {
      if (seen.has(listing.id)) continue;
      if (filterBox && listing.location && !inBox(filterBox, listing.location.lat, listing.location.lng)) continue;
      seen.add(listing.id);
      await emit({ query, listing });
    }
  };

  let boxes: BBox[];
  try {
    if ('bbox' in query.area) {
      boxes = unwrapBox(query.area.bbox);
    } else {
      const first = await fetchPage(call, query, null);
      if (!first.bounds) {
        await yieldPage(first);
        if (first.pageCount > 1) note(new AirbnbError('Unknown', `Airbnb gave no map area for "${query.area.place}", so the search cannot be split`));
        return incomplete;
      }
      boxes = unwrapBox(first.bounds);
    }
  } catch (cause) {
    return toAirbnbError(cause);
  }

  const queue: Cell[] = [];
  for (const box of boxes) for (const [min, max] of seedBands(query.nightlyPrice)) queue.push({ box, min, max });

  let running = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (running < ctx.concurrency && queue.length > 0 && !call.stopped) {
        const cell = queue.shift()!;
        running++;
        void processCell(cell).finally(() => {
          running--;
          pump();
        });
      }
      if (running === 0 && (queue.length === 0 || call.stopped)) resolve();
    };
    const processCell = async (cell: Cell) => {
      try {
        const page = await fetchPage(call, query, cell);
        // Every page's listings count, including one about to be split: the
        // pieces return some of them again, which `seen` drops. A search that
        // runs out of budget, or runs many cells at once, still yields what it
        // fetched.
        await yieldPage(page);
        if (page.pageCount <= 1) return;
        const bands = splitBand(cell.min, cell.max, page.resultCount);
        if (bands) {
          // Depth first: a split piece runs before the next seed band, so listings arrive early and a budget-limited search still returns many.
          queue.unshift(...bands.map(([min, max]) => ({ box: cell.box, min, max })));
          return;
        }
        const halves = splitBox(cell.box);
        if (halves) {
          queue.unshift(...halves.map((box) => ({ ...cell, box })));
          return;
        }
        note(new AirbnbError('Unknown', `more than one page of results in a ${MIN_BOX_SIDE_KM} km box at a single price`));
      } catch (cause) {
        note(toAirbnbError(cause));
      }
    };
    pump();
  });
  if (call.stopped && queue.length > 0) note(call.error!);
  return incomplete;
}
