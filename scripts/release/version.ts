/**
 * Chooses the version a release publishes. `node scripts/release/version.ts`
 * prints it.
 *
 * package.json's version is a floor the maintainer sets by hand: raising it
 * to the next minor or major releases that version. Otherwise the release is
 * the next patch after the highest version already released, whether that
 * version is known from a `v*` git tag or from npm. Checking both means a run
 * that published to npm but failed before tagging cannot reuse its version.
 * See docs/release.md.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type Triple = [number, number, number];

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parse(version: string): Triple | null {
  const m = SEMVER.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The next version, given package.json's version and every version released so far. */
export function nextVersion(declared: string, released: string[]): string {
  const floor = parse(declared);
  if (!floor) throw new Error(`package.json version ${declared} is not MAJOR.MINOR.PATCH`);
  // Prereleases and other non-plain versions are not part of the release line.
  const versions = released.map(parse).filter((v): v is Triple => v !== null);
  if (versions.length === 0) return floor.join('.');
  const highest = versions.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  if (compare(floor, highest) > 0) return floor.join('.');
  return [highest[0], highest[1], highest[2] + 1].join('.');
}

function gitTags(): string[] {
  return execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** Every version of the package on npm; none before its first publish. */
function npmVersions(name: string): string[] {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (stderr.includes('E404')) return [];
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string };
  console.log(nextVersion(pkg.version, [...gitTags(), ...npmVersions(pkg.name)]));
}
