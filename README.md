# airbnb-dlp

Airbnb listing data for any area, from a library that keeps working when Airbnb changes its site. A scheduled live check finds breakage, files an issue, and a coding agent repairs it under the rules in [AGENTS.md](AGENTS.md).

Unofficial; not affiliated with Airbnb, Inc.

```ts
import { createClient, type SearchHit } from 'airbnb-dlp';

const client = createClient();
const search = client.search([{ area: { place: 'Austin, TX' }, roomTypes: ['entire_home'] }]);

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

Search is complete: each query splits itself by price and by area until no piece hits Airbnb's result cap. Without stay dates, Airbnb prices each listing for a one-week trip, and price filters apply to that price.

Known limitation: Airbnb ignores the `shared_room` room-type filter and returns other room types. Search cards do not carry a room type, so the library cannot filter them itself; check `Listing.roomType` from `listings()`.

Every method is bulk and returns a `Batch`, modelled on fetch's `Response`. `items()` streams results as they finish, and `outcome()` resolves with what ended the call early, which inputs are incomplete, and how many requests were made. It never rejects. One listing failing yields a typed error for that item and the rest continue. A `Blocked` failure ends the call.

One client holds one request budget, shared by all its calls: at most 1 request a second and 4 in flight by default. A caller can lower these, set `maxRequests` or `maxDurationMs`, or pass an `AbortSignal`, but cannot raise the rate. When Airbnb blocks requests, the library reports `Blocked`; it does not change its fingerprint or route around the block.

## Runtimes

Parsing works on Node, Bun, Deno and in browsers. Live fetching works on Node 22+, Bun and Deno (`deno run -A`), through [impit](https://github.com/apify/impit), which sends Chrome's TLS fingerprint. Browsers, workers and edge runtimes get a build with no default transport, so `createClient` there needs a `transport`.

Transport, clock and random source are injectable. The `airbnb-dlp/testing` subpath has `recordingTransport`, `replayTransport` and `manualClock` for your own tests.

## Development

```bash
pnpm install
pnpm test
pnpm live-check --small
```

See [AGENTS.md](AGENTS.md) for the repair workflow and what each part of the repository is.

## Maintainer setup

The repair loop needs these repository settings:

- **Live-check GitHub App** with Issues, Pull requests and Contents (read and write) permissions and no Workflows permission, installed on this repository. Variables `LIVE_CHECK_APP_ID` and `LIVE_CHECK_BOT_LOGIN` (its `<slug>[bot]` login); secret `LIVE_CHECK_APP_PRIVATE_KEY`.
- **Agent**: the Claude GitHub App installed, secret `AGENT_ANTHROPIC_API_KEY` (a key with its own monthly spend limit), variable `AGENT_BOT_LOGIN` (the login its pull requests are opened by), optional `AGENT_MAX_RUNS_PER_MONTH` (default 20).
- **Ruleset on `main`**: require a pull request, code-owner review, and the status checks `checks`, `fixtures (node)`, `fixtures (bun)`, `fixtures (deno)`, `fixtures (browser)`, `path-allowlist` and `live-check (node)`, each pinned to GitHub Actions; no bypass list. Allow auto-merge.
- **npm**: secret `NPM_TOKEN` for releases.
- Labels: `live-check`, `agent-repair`, `needs-maintainer`, and `category:<name>` for each failure category (created on first use).

## License

MIT
