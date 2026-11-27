# Releases

airbnb-dlp is published to npm as [`airbnb-dlp`](https://www.npmjs.com/package/airbnb-dlp) by [`.github/workflows/release.yml`](../.github/workflows/release.yml). Every merge to `main` that changes the package publishes a new version after that exact tarball has passed the live check against airbnb.com. A downstream user who upgrades to the latest version gets a build that worked against airbnb.com when it was published.

This file is maintainer-only (it is in `contract/protected-paths.json`), as are `scripts/release/` and the workflow.

## Versioning

Versions follow [SemVer](https://semver.org) and describe the public contract in `contract/`, mainly the exported API in `contract/api-snapshot.d.ts.txt`:

| Part | When | Who decides |
|---|---|---|
| Patch, `1.4.2` → `1.4.3` | Any release that keeps the contract: every repair, and maintainer fixes | Automatic |
| Minor, `1.4.3` → `1.5.0` | The contract grows in a compatible way: a new export, product, option or field | The maintainer, in `package.json` |
| Major, `1.5.0` → `2.0.0` | The contract changes incompatibly: a removed or changed export, a field that changes type or meaning | The maintainer, in `package.json` |

The repair agent cannot edit `contract/` or `package.json`, so its changes are patches by construction.

A version does not say whether it works against airbnb.com today. When Airbnb changes its site, every earlier version breaks at once; the release that repairs it is the newest version, so upgrading to `latest` is the fix. Earlier versions are not deprecated: `npm deprecate` needs a person with two-factor authentication or a long-lived token, and this setup has neither in CI.

### How the version is chosen

`scripts/release/version.ts` chooses the version:

- `package.json`'s `version` is a floor. If it is higher than every released version, the release publishes it exactly.
- Otherwise the release is the next patch after the highest released version.
- "Released" means a `v*` git tag or a version on npm. Checking both stops a run that published but failed before tagging from reusing its version.

`package.json` on `main` therefore holds the last version the maintainer set, such as `1.0.0`, not the latest release. The tarball's `package.json` has the real version, and every release has a `v<version>` tag and a GitHub release on the commit it was built from.

### Which major gets repairs

Only the newest major gets repairs. When `2.0.0` is released, 1.x gets no further releases (see [Starting a new major](#starting-a-new-major)).

## What a release does

The workflow runs on a push to `main` that changes `src/**`, `package.json`, `scripts/build.ts` or `tsconfig.build.json`, and on demand from the Actions tab (Release, Run workflow). Runs are queued one at a time.

1. **pack**: runs the unit tests, chooses the version, writes it into `package.json` and runs `npm pack`, which builds `dist/`. The tarball is uploaded as the `package` artifact.
2. **verify**, once each on node, bun and deno: installs the tarball into an empty project, as a user would, and runs the live check against that installed package (`scripts/live-check/run.ts --package <dir>`). Node runs the full check and bun and deno the small one. A file missing from the tarball or a broken build fails here, not on users' machines.
3. **publish**, only if every verify passed:
   - publishes the same tarball file to npm under the `latest` dist-tag, with provenance;
   - creates the GitHub release `v<version>`. Its notes say when and on which runtimes the package was checked, list the fill rates from node's run, and list the merged pull requests.

npm's `latest` therefore only ever points at a tarball that passed the live check.

Publishing uses npm trusted publishing: npm accepts the workflow's GitHub OIDC identity in place of a token. The trusted publisher is tied to `release.yml` and the GitHub environment `npm`, which only `main` can deploy to. The package refuses tokens, so there is no npm credential stored anywhere to leak or rotate, and the release workflow on `main` is the only automated way to publish.

## What downstream users should do

The README tells users to depend on `airbnb-dlp@^1` and to keep their lockfile current, for example with Renovate or Dependabot set to merge patch updates automatically. A lockfile pins a version, so a repair only reaches them when the lockfile is updated.

## Procedures

### One-time setup

npm does not let a trusted publisher be added before the package exists, so the maintainer publishes `1.0.0` from their own machine. [`scripts/release/setup-npm.sh`](../scripts/release/setup-npm.sh) walks through these steps and runs the commands; each step checks whether it is already done, so it can be re-run after a failure.

1. **GitHub environment**: the environment `npm`, limited to `main` (Settings, Environments). Only release runs from `main` can use it and its secrets.
2. **Pause releases**: `gh workflow disable release.yml`, so merging the release tooling does not start a release that cannot authenticate yet.
3. **Merge** the pull request that sets `package.json` to `1.0.0`.
4. **npm account**: `npm login`, as the account that will own the package, with two-factor authentication on.
5. **First publish**, from the merge commit: run the tests, `npm pack`, install the tarball into an empty project, run `pnpm live-check --small --package <dir>` against it, then `npm publish <tarball> --access public`. A package published from a laptop has no provenance; every later release does.
   npm can hold a new package's first version for review. While it does, the registry lists only a placeholder version `0.0.0-stage`, `npm view airbnb-dlp@1.0.0` answers 404, `npm stage list` is empty, and publishing `1.0.0` again fails with 409 "Cannot publish over previously staged version". The hold on airbnb-dlp's `1.0.0` cleared within an hour with no action from the maintainer. The steps below need only the package to exist, so the wizard continues during a hold and creates the GitHub release on a later run.
6. **Tag** the merge commit `v1.0.0` with a GitHub release, so the next release is `1.0.1`.
7. **Trusted publisher**:
   ```bash
   npm trust github airbnb-dlp --repo NickCrews/airbnb-dlp --file release.yml --env npm --allow-publish
   ```
8. **Refuse tokens**: set the package's Publishing access to "Require two-factor authentication and disallow tokens". Trusted publishing keeps working; any token, including a leaked one, can no longer publish.
   ```bash
   npm access set mfa=publish airbnb-dlp
   ```
9. **Resume releases**: `gh workflow enable release.yml`.

### Releasing a minor or major

1. In the pull request that changes the contract, set `package.json`'s `version` to the new version, such as `1.5.0` or `2.0.0`, and update `contract/api-snapshot.d.ts.txt`.
2. Merge it. The release publishes exactly that version. Later merges release `1.5.1`, `1.5.2` and so on.

### Starting a new major

Optionally, after `2.0.0` is published, deprecate the old major from your machine (`npm login`; npm asks for two-factor authentication):

```bash
npm deprecate "airbnb-dlp@1.x" "1.x no longer receives repairs for airbnb.com changes. Upgrade to 2.x; see the 2.0.0 release notes."
```

### When verify fails

Nothing was published, and `latest` still points at the previous release. Read the failed verify job's log and its `live-check-report-*` artifact.

- **The same failure is on `main`**, for example Airbnb changed something or blocked the runner: the scheduled live check files it within 4 hours and the repair agent takes it. The repair's merge starts a new release, which includes the unreleased change.
- **A block that has cleared**: run the workflow again from the Actions tab (Release, Run workflow, `main`).
- **Only the packed build fails**, while the live check on `main`'s source passes: the tarball is missing a file or the build differs from the source. Check `files` in `package.json`, `scripts/build.ts` and `tsconfig.build.json`. This is a maintainer fix; the repair agent cannot edit those paths.

### When publish succeeded but a later step failed

- **GitHub release missing**: create it by hand at the commit the run built from:
  ```bash
  gh release create vX.Y.Z --target <commit> --title vX.Y.Z --generate-notes
  ```
  The next release's version is still correct, because the version check also reads npm.

### Withdrawing a bad release

Do not unpublish: users' lockfiles may already pin the version, and npm never allows that version number again. Fix forward with a new patch. Optionally, deprecate the bad version from your machine:

```bash
npm deprecate "airbnb-dlp@X.Y.Z" "<what is wrong>. Upgrade to X.Y.(Z+1)."
```

If the fix will take a while, point `latest` back at the last good version:

```bash
npm dist-tag add airbnb-dlp@<good version> latest
```

The next release moves `latest` forward again.
