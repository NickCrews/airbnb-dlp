# airbnb-dlp

[![CI](https://github.com/NickCrews/airbnb-dlp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/NickCrews/airbnb-dlp/actions/workflows/ci.yml?query=branch%3Amain)
[![Live check against airbnb.com, every 4 hours](https://github.com/NickCrews/airbnb-dlp/actions/workflows/live-check.yml/badge.svg?event=schedule)](https://github.com/NickCrews/airbnb-dlp/actions/workflows/live-check.yml?query=event%3Aschedule)
[![Repair-loop drill](https://github.com/NickCrews/airbnb-dlp/actions/workflows/drill.yml/badge.svg)](https://github.com/NickCrews/airbnb-dlp/actions/workflows/drill.yml)

Airbnb client in typescript: search results, listing details, availability calendars, price quotes and reviews.

When Airbnb changes its site, a [scheduled live check](https://github.com/NickCrews/airbnb-dlp/actions/workflows/live-check.yml) catches it and triggers an agent to repair the library. The goal is to publish a new release to npm within a few hours after a breakage. Inspired by [yt-dlp](https://github.com/yt-dlp/yt-dlp), a piece of web infrastructure that somehow just keeps working even when YouTube keeps changing underneath it.

Unofficial; not affiliated with Airbnb, Inc.

## Install

airbnb-dlp is not on npm yet. Build a package from a clone and install that:

```bash
git clone https://github.com/NickCrews/airbnb-dlp.git
```

```bash
cd airbnb-dlp && pnpm install && pnpm pack
```

```bash
npm install /path/to/airbnb-dlp/airbnb-dlp-0.1.0.tgz
```

Live fetching needs Node 22+, Bun or Deno. See [Runtimes](#runtimes) for browsers and edge runtimes.

## Example

```ts
import { createClient, type SearchHit } from 'airbnb-dlp';

const client = createClient();
const search = client.search([{ area: { place: 'Austin, TX' }, minBedrooms: 2 }]);

async function* ids(hits: AsyncIterable<SearchHit>) {
  for await (const hit of hits) yield hit.listing.id;
}

// Calendars start fetching while the search is still running.
const calendars = client.calendars(ids(search.items()));
for await (const r of calendars.items()) {
  if (!r.ok) console.warn(r.input, r.error.category);
}

const { error, incomplete } = await search.outcome();
```

## What it returns

| Method | Input | Each item |
|---|---|---|
| `search` | queries: an area (bounding box or place) plus filters | a `SearchHit`: the query and a listing card |
| `listings` | listing ids | listing-page attributes: location, room and property type, capacity, beds, bedrooms, bathrooms, registration text, host, photos |
| `calendars` | listing ids | nightly availability with check-in, check-out and night rules |
| `priceQuotes` | stays | the total and its breakdown |
| `reviews` | listing ids | review dates, newest first, and Airbnb's total |

Search is complete: each query splits itself by price and by area until no piece hits Airbnb's result cap. Without stay dates, Airbnb prices each listing for a one-week trip, and price filters apply to that price. A `place` is resolved by Airbnb to a map area, so results can include listings near the place but outside its boundary; pass a `bbox` for an exact area.

Search has no room-type filter: Airbnb's own filter ignores some room types, and search cards do not say which a listing is. Filter on `Listing.roomType` from `listings()` instead.

Listing ids are strings, since newer ids are beyond a JavaScript number's precision.

### Helpers

- `bookableStays(calendar, from)` lists every stay a calendar shows as bookable, applying its check-in, check-out and night rules. Feed it to `priceQuotes`.
- `listingUrl(id)` gives the listing's page on airbnb.com.
- `propertyGroup(type)` maps a listing's property type to the group search filters on.
- `AMENITIES` maps amenity names to Airbnb's ids.

## Bulk calls and errors

Every method is bulk and returns a `Batch`, modelled on fetch's `Response`:

- `items()` streams results as they finish. Inputs can be an async iterable, so one call's items can feed the next.
- `outcome()` resolves with what ended the call early, which inputs are incomplete, and how many requests were made. It never rejects.
- `all()` reads every item into memory, then the outcome.

One listing failing yields a typed error for that item and the rest continue. Each error has a `category`:

| Category | Meaning |
|---|---|
| `NotFound` | the listing is removed or hidden |
| `StayUnavailable` | Airbnb will not quote that stay |
| `Transient` | a server or network error that persisted through retries |
| `BudgetExhausted` | not attempted because `maxRequests` or `maxDurationMs` was reached |
| `Aborted` | the call's `AbortSignal` fired |
| `RequestRejected`, `ResponseChanged` | Airbnb changed something; upgrading usually fixes it |
| `Blocked` | Airbnb refused this client, or kept rate-limiting it; ends the whole call |
| `Unknown` | anything else |

Each error carries the last HTTP exchange, bodies included, for debugging.

## Request rate

One client holds one request budget, shared by all its calls, and its pace adapts to Airbnb. It starts at 2 requests a second and speeds up while requests are served normally, up to 20 a second with 8 in flight. A rate limit (HTTP 429) halves the pace and pauses every request for as long as Airbnb's `Retry-After` asks, up to a minute; after three on one request, or a longer `Retry-After`, the call ends as `Blocked`. A challenge page, 403 or 428 ends the call at once. You can lower the ceilings with `createClient({ limits })`, cap a call with `maxRequests` or `maxDurationMs`, or pass an `AbortSignal`, but you cannot raise them. The `trace` option reports every change of pace. The client does not use proxies, rotate IP addresses or solve challenges.

## Runtimes

Parsing works on Node, Bun, Deno and in browsers. Live fetching works on Node 22+, Bun and Deno (`deno run -A`), through [impit](https://github.com/apify/impit), which sends a current browser's TLS fingerprint (Chrome's by default). Browsers, workers and edge runtimes get a build with no default transport, so `createClient` there needs a `transport`.

Transport, clock and random source are injectable. The `airbnb-dlp/testing` subpath has `recordingTransport`, `replayTransport` and `manualClock` for your own tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
