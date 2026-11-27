# airbnb-dlp

Airbnb listing data for any area, from a library that keeps working when Airbnb changes its site. A scheduled live check finds breakage, files an issue, and a coding agent repairs it under the rules in [AGENTS.md](AGENTS.md).

Unofficial; not affiliated with Airbnb, Inc.

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

Search is complete: each query splits itself by price and by area until no piece hits Airbnb's result cap. Without stay dates, Airbnb prices each listing for a one-week trip, and price filters apply to that price.

Search has no room-type filter: Airbnb's own filter ignores some room types, and search cards do not say which a listing is. Filter on `Listing.roomType` from `listings()` instead.

Every method is bulk and returns a `Batch`, modelled on fetch's `Response`. `items()` streams results as they finish, and `outcome()` resolves with what ended the call early, which inputs are incomplete, and how many requests were made. It never rejects. One listing failing yields a typed error for that item and the rest continue. A `Blocked` failure ends the call.

One client holds one request budget, shared by all its calls: at most 1 request a second and 4 in flight by default. A caller can lower these, set `maxRequests` or `maxDurationMs`, or pass an `AbortSignal`, but cannot raise the rate. The defaults stay within what Airbnb allows; the repair loop may move them up or down to that limit. When Airbnb blocks requests, the library reports `Blocked`. The repair loop may update headers and the TLS fingerprint to match a current browser, but never uses proxies, rotates IP addresses or solves challenges.

## Runtimes

Parsing works on Node, Bun, Deno and in browsers. Live fetching works on Node 22+, Bun and Deno (`deno run -A`), through [impit](https://github.com/apify/impit), which sends a current browser's TLS fingerprint (Chrome's by default). Browsers, workers and edge runtimes get a build with no default transport, so `createClient` there needs a `transport`.

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

- **Live-check GitHub App** with Issues, Pull requests and Contents (read and write) permissions and no Workflows permission, installed on this repository. Drills use it to push `drill/*` branches and merge repairs into them, so the ruleset must not cover `drill/*`. Variables `LIVE_CHECK_APP_ID` and `LIVE_CHECK_BOT_LOGIN` (its `<slug>[bot]` login); secret `LIVE_CHECK_APP_PRIVATE_KEY`.
- **Agent**: the Claude GitHub App installed, secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, so runs draw on the maintainer's Claude subscription), variable `AGENT_BOT_LOGIN` (the login its pull requests are opened by), optional `AGENT_MAX_RUNS_PER_MONTH` (default 20).
- **Ruleset on `main`**: require a pull request, code-owner review, and the status checks `checks`, `fixtures (node)`, `fixtures (bun)`, `fixtures (deno)`, `fixtures (browser)`, `path-allowlist` and `live-check (node)`, each pinned to GitHub Actions. The only bypass is repository admins in pull-request mode, so the maintainer can merge their own pull requests to code-owned paths but nobody can push to `main` directly. Allow auto-merge.
- **npm**: secret `NPM_TOKEN` for releases.
- Labels: `live-check`, `agent-repair`, `needs-maintainer` and `drill`. A failing live check opens one issue with `agent-repair`, and later failing runs comment on it only when the failing checks change; the agent adds `needs-maintainer` when it cannot fix it.

## Drills

The **Drill** workflow (Actions, Run workflow) tests the self-healing loop without waiting for Airbnb to change. Its `scenario` input chooses what to break:

| Scenario | Breaks | Expected path |
|---|---|---|
| `none` | nothing: a plain full live-check run | none |
| `stale-hash` | the reviews query's persisted-query hash | RequestRejected, repaired by the agent |
| `parser-break` | the calendar parser's date field | ResponseChanged, repaired by the agent |
| `blocked` | every response in the drill's live check becomes a 429 | Blocked; the agent's own run does not reproduce it, so it closes or hands over the issue without a pull request |

A drill commits the breakage to a new `drill/<run id>` branch, runs the live check there, and files the issue through the real path with a `drill` label. The agent repairs against the drill branch. The drill then waits for the required checks on the agent's pull request, merges it into the drill branch, and runs the live check again. The run summary has a pass or fail for each step. Afterwards the drill closes its issue and deletes its branch, unless `keep_branch` is set. Nothing touches `main` and nothing is released. Drill runs count toward the agent's monthly run limit.

The agent can see the drill branch's history, so a drill tests the loop's plumbing and the agent's diagnosis under easy conditions, not under a real upstream change.

## License

MIT
