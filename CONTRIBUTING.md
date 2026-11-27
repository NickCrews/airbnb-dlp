# Contributing

[AGENTS.md](AGENTS.md) has the rules for every contributor, human or coding agent: how the code is laid out, how to repair a failing live check, and which paths only the maintainer changes.

## Development

```bash
pnpm install
pnpm test                       # unit and fixture tests
pnpm typecheck
pnpm lint
pnpm api-snapshot               # fails if the public API changed
pnpm live-check --small         # live run against airbnb.com: about 40 requests
```

## How the library stays working

A scheduled live check runs the library against airbnb.com. When it fails, it opens an issue, and a coding agent repairs it under the rules in [AGENTS.md](AGENTS.md). The agent may update how requests are built, how responses are parsed, request headers, the TLS fingerprint profile and the default request rate, but never uses proxies, rotates IP addresses or solves challenges.

## Maintainer setup

The repair loop needs these repository settings:

- **Live-check GitHub App** with Issues, Pull requests and Contents (read and write) permissions and no Workflows permission, installed on this repository. Drills use it to push `drill/*` branches and merge repairs into them, so the ruleset must not cover `drill/*`. Variables `LIVE_CHECK_APP_ID` and `LIVE_CHECK_BOT_LOGIN` (its `<slug>[bot]` login); secret `LIVE_CHECK_APP_PRIVATE_KEY`.
- **Agent**: the Claude GitHub App installed, secret `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, so runs draw on the maintainer's Claude subscription), variable `AGENT_BOT_LOGIN` (the login its pull requests are opened by), optional `AGENT_MAX_RUNS_PER_MONTH` (default 20).
- **Ruleset on `main`**: require a pull request, code-owner review, and the status checks `checks`, `fixtures (node)`, `fixtures (bun)`, `fixtures (deno)`, `fixtures (browser)`, `path-allowlist`, `live-check (node)` and `benchmark`, each pinned to GitHub Actions. The only bypass is repository admins in pull-request mode, so the maintainer can merge their own pull requests to code-owned paths but nobody can push to `main` directly. Allow auto-merge.
- **npm**: trusted publishing for `release.yml` and the GitHub environment `npm` (limited to `main`); the package refuses tokens. Setup and release procedures are in [docs/release.md](docs/release.md).
- Labels: `live-check`, `agent-repair`, `needs-maintainer`, `agent-queued`, `live-check-notice` and `drill`. A failing live check opens one issue with `agent-repair`, and later failing runs comment on it only when the failing checks change; the agent adds `needs-maintainer` when it cannot fix it. Each live-check notice, a finding that does not fail the run, opens its own issue with `live-check-notice` and `agent-repair`, one open issue per check; the agent fixes it or hands it over like a failure.
- **Agent queue**: `agent-queue.yml` runs hourly and starts a repair session for every open live-check issue still waiting for one: labeled `agent-repair`, not `needs-maintainer`, with no open pull request from the agent and no session running. A session that stops on the Claude subscription's usage limit labels its issue `agent-queued` instead of handing it over, so the next hour after the limit resets picks it up. Each retry counts toward `AGENT_MAX_RUNS_PER_MONTH`.

## Drills

The **Drill** workflow (Actions, Run workflow) tests the self-healing loop without waiting for Airbnb to change. Its `scenario` input chooses what to break:

| Scenario | Breaks | Expected path |
|---|---|---|
| `none` | nothing: a plain full live-check run | none |
| `stale-hash` | the reviews query's persisted-query hash | RequestRejected, repaired by the agent |
| `parser-break` | the calendar parser's date field | ResponseChanged, repaired by the agent |

A drill commits the breakage to a new `drill/<run id>` branch, runs the live check there, and files the issue through the real path with a `drill` label. The agent repairs against the drill branch. The drill then waits for the required checks on the agent's pull request, merges it into the drill branch, and runs the live check again. The run summary has a pass or fail for each step. Afterwards the drill closes its issue and deletes its branch, unless `keep_branch` is set. Nothing touches `main` and nothing is released. Drill runs count toward the agent's monthly run limit.

The agent can see the drill branch's history, so a drill tests the loop's plumbing and the agent's diagnosis under easy conditions, not under a real upstream change.
