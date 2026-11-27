import type { AirbnbError, ErrorCategory } from './errors.ts';

/**
 * A decimal string: newer ids have 19 digits, beyond a JS number's precision.
 * A string rather than a bigint, so results survive JSON.stringify.
 */
export type ListingId = string;
/** 'YYYY-MM-DD', a date at the listing's location. */
export type IsoDate = string;
export interface LatLng {
  lat: number;
  lng: number;
}
/** amount is in major units (dollars). For exact sums, convert to minor units or a decimal type first. */
export interface Money {
  amount: number;
  currency: string;
}

export interface Guests {
  adults?: number;
  children?: number;
  infants?: number;
  pets?: number;
}

// ---------------------------------------------------------------- client

export type Transport = (request: TransportRequest, signal: AbortSignal) => Promise<TransportResponse>;
export interface TransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body: string | null;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ClientOptions {
  /** Default on Node, Bun and Deno: impit. Required in browsers, workers and edge runtimes, which have no default. */
  transport?: Transport;
  /** Default: the system clock and timers. */
  clock?: Clock;
  /** Returns a number in [0, 1). Default: Math.random. */
  random?: () => number;
  /** ISO 4217 code for every price. Default: 'USD'. */
  currency?: string;
  /** Each value can only lower the default. */
  limits?: { requestsPerSecond?: number; concurrency?: number };
  /**
   * Receives an event for each call and each request: when it was queued and
   * sent, its status, size and time, and each retry. For logs, metrics and
   * benchmarks. It runs synchronously on the request path, so keep it cheap;
   * an error it throws is ignored.
   */
  trace?: (event: TraceEvent) => void;
}

/**
 * What a client did, as `trace` receives it. `at` is the client clock's time in
 * milliseconds. `call` numbers each bulk call and `request` each request, from
 * 1 per client; a retried request keeps its number with a higher `attempt`.
 */
export type TraceEvent =
  | { type: 'call.start'; at: number; call: number; product: Product }
  | {
      type: 'call.end';
      at: number;
      call: number;
      product: Product;
      /** Items the call yielded, failed results included. */
      items: number;
      requests: number;
      incomplete: number;
      /** What ended the call early, or null. */
      error: ErrorCategory | null;
    }
  | {
      type: 'request';
      at: number;
      call: number;
      request: number;
      attempt: number;
      method: TransportRequest['method'];
      url: string;
      /** Time spent waiting for the client's pace and concurrency limits. */
      queuedMs: number;
    }
  | {
      type: 'response';
      at: number;
      call: number;
      request: number;
      attempt: number;
      status: number;
      bytes: number;
      ms: number;
      /** How the status was classified, or null for a response the product parses. */
      category: ErrorCategory | null;
    }
  | { type: 'request.error'; at: number; call: number; request: number; attempt: number; ms: number; category: ErrorCategory; message: string }
  | { type: 'retry'; at: number; call: number; request: number; attempt: number; delayMs: number; category: ErrorCategory };

/** The client method a call came from. */
export type Product = 'search' | 'listings' | 'calendars' | 'priceQuotes' | 'reviews';

export interface Client {
  search(queries: Inputs<SearchQuery>, options?: CallOptions): Batch<SearchQuery, SearchHit>;
  listings(ids: Inputs<ListingId>, options?: CallOptions): Batch<ListingId, Result<ListingId, Listing>>;
  calendars(ids: Inputs<ListingId>, options?: CalendarOptions): Batch<ListingId, Result<ListingId, Calendar>>;
  priceQuotes(stays: Inputs<Stay>, options?: CallOptions): Batch<Stay, Result<Stay, PriceQuote>>;
  reviews(ids: Inputs<ListingId>, options?: ReviewsOptions): Batch<ListingId, Result<ListingId, Reviews>>;
}

/** Inputs may be a stream, so one call's items can feed the next call. */
export type Inputs<T> = Iterable<T> | AsyncIterable<T>;

/**
 * One bulk call, modelled on fetch's Response. The work starts when the call
 * is made. New requests pause while a small buffer of items is unread.
 */
export interface Batch<I, T> {
  /** Each item once, in completion order. Readable once; a second call throws. Ends normally, also after an early stop. */
  items(): AsyncIterable<T>;
  /** Resolves when the call ends. Never rejects. Called before items() is read, it drains and discards the items. */
  outcome(): Promise<Outcome<I>>;
  /** Reads every item into memory, then the outcome. */
  all(): Promise<{ items: T[]; outcome: Outcome<I> }>;
}

export interface Outcome<I> {
  /** What ended the call early: a BlockedError, an abort, or null. */
  error: AirbnbError | null;
  /** Each input not fully covered, and why: not attempted, failed, or a search cut short. Empty when every input completed. */
  incomplete: { input: I; error: AirbnbError }[];
  /** Requests made to Airbnb, retries included. */
  requests: number;
}

/** Every input of a non-search call yields exactly one Result, including inputs never attempted ('BudgetExhausted'). */
export type Result<I, T> = { input: I; ok: true; value: T } | { input: I; ok: false; error: AirbnbError };

export interface CallOptions {
  signal?: AbortSignal;
  /** Start no new requests after this many. */
  maxRequests?: number;
  /** Start no new requests after this long, on the client's clock. */
  maxDurationMs?: number;
}

export interface CalendarOptions extends CallOptions {
  /** Months from the current month. Default: 12. */
  months?: number;
}

export interface ReviewsOptions extends CallOptions {
  /** Newest first. Default: 'all', which pages to the oldest review. */
  limit?: number | 'all';
}

// ---------------------------------------------------------------- search

export interface SearchQuery {
  area: Area;
  stay?: { checkIn: IsoDate; checkOut: IsoDate };
  guests?: Guests;
  /** Per night, in the client's currency. */
  nightlyPrice?: { min?: number; max?: number };
  minBedrooms?: number;
  minBeds?: number;
  minBathrooms?: number;
  propertyGroups?: PropertyGroup[];
  amenities?: Amenity[];
  instantBook?: boolean;
}

/**
 * A bbox with west > east crosses the antimeridian. A place is resolved by Airbnb to a map area,
 * so results can include listings near the place but outside its boundary.
 */
export type Area = { bbox: BBox } | { place: string };
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type RoomType = 'entire_home' | 'private_room' | 'shared_room' | 'hotel_room';
/**
 * The listing page's propertyType enum: 'HOUSE' | 'CONDOMINIUM' | 'APARTMENT' | 'HOTEL' | 'BNB' | 'CABIN'
 * | 'TOWNHOUSE' | 'GUESTHOUSE' | 'PRIVATE_SUITE' | 'DOME' | 'TINY_HOUSE' | 'EARTHHOUSE' | 'FARMSTAY'
 * | 'SHIPPING_CONTAINER' | ...
 */
export type PropertyType = string;
/** Search filters property types in only four groups. */
export type PropertyGroup = 'house' | 'guesthouse' | 'apartment' | 'hotel';
/** Library names for Airbnb's numeric amenity ids, e.g. 'wifi' (4), 'kitchen' (8), 'hot_tub' (25). See AMENITIES. */
export type Amenity = string;

/**
 * One listing found by one query, streamed as found. Each listing appears once
 * per query; a listing matching two queries appears once for each. Whether a
 * query covered its whole area is in Outcome.incomplete.
 */
export interface SearchHit {
  query: SearchQuery;
  listing: SearchListing;
}

export interface SearchListing {
  id: ListingId;
  name: string | null;
  title: string | null;
  /** Jittered unless the host shows the exact location; see Listing.location.exact. */
  location: LatLng | null;
  rating: number | null;
  reviewCount: number | null;
  badges: string[];
  /**
   * Without stay dates, Airbnb prices a stay it picks, usually 5 nights. total is that stay's price;
   * nights and nightly come from the breakdown line, e.g. "5 nights x $187.20".
   */
  price: { total: Money | null; nights: number | null; nightly: Money | null } | null;
}

// ---------------------------------------------------------------- listing

export interface Listing {
  id: ListingId;
  location: (LatLng & { exact: boolean | null }) | null;
  /** Set only when the host publishes a street address. */
  address: string | null;
  /** From Airbnb's roomType value; null if Airbnb sends one the library does not know. */
  roomType: RoomType | null;
  /** Airbnb's propertyType enum value, e.g. 'HOUSE', 'TENT', 'HOSTEL'. */
  propertyType: PropertyType | null;
  guestCapacity: number | null;
  /** Airbnb's bed count, as it reports it: a bunk bed counts as 2, and 0 can mean the host entered none. */
  beds: number | null;
  /**
   * Parsed from the page's bedroom line: "2 bedrooms" is 2, "Studio" is 0.
   * Null when the page has no bedroom line; count is null when the wording is not recognised.
   */
  bedrooms: { count: number | null; text: string } | null;
  /**
   * Parsed from the page's bathroom line: "1.5 shared baths" is { count: 1.5, access: 'shared' },
   * "Half-bath" counts 0.5, "No bathroom" is 0, "Shared bathroom" has a null count. A bare "N baths" is private.
   * Null when the page has no bathroom line; count and access are null when the wording is not recognised.
   */
  bathrooms: { count: number | null; access: 'private' | 'dedicated' | 'shared' | null; text: string } | null;
  /** The "Registration Details" text as the host entered it, unparsed. Formats vary by city; some read "Exempt". */
  registration: string | null;
  host: Host | null;
  /** In the host's order; the first is the cover photo. */
  photoUrls: string[];
}

export interface Host {
  /** Account id: airbnb.com/users/show/<id>. */
  id: string;
  /** A first name or a business name. */
  name: string | null;
  about: string | null;
  timeAsHost: { years: number; months: number } | null;
}

// ---------------------------------------------------------------- calendar, quote, reviews

export interface Calendar {
  id: ListingId;
  days: CalendarDay[];
}

export interface CalendarDay {
  date: IsoDate;
  available: boolean;
  checkInAllowed: boolean;
  checkOutAllowed: boolean;
  minNights: number | null;
  maxNights: number | null;
}

export interface Stay {
  id: ListingId;
  checkIn: IsoDate;
  checkOut: IsoDate;
  guests?: Guests;
}

export interface PriceQuote {
  /** A stay Airbnb will not quote is a StayUnavailable error, not a quote. */
  total: Money;
  /** Each line as shown, e.g. "5 nights x $120", "Cleaning fee $80". */
  breakdown: string[];
}

export interface Reviews {
  id: ListingId;
  /** Airbnb's count of all reviews. */
  total: number | null;
  /** Newest first. */
  reviews: Review[];
}

export interface Review {
  /** ISO 8601 UTC timestamp. */
  createdAt: string;
}
