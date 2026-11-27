import { describe, expect, it } from 'vitest';
import { nextVersion } from '../scripts/release/version.ts';
import { releaseNotes } from '../scripts/release/notes.ts';
import type { Report } from '../scripts/live-check/contract.ts';

describe('release version', () => {
  it("releases package.json's version when nothing is released yet", () => {
    expect(nextVersion('1.0.0', [])).toBe('1.0.0');
  });
  it('releases the next patch after the highest released version', () => {
    expect(nextVersion('1.0.0', ['v1.0.0', 'v1.0.1'])).toBe('1.0.2');
  });
  it('counts versions published to npm but never tagged', () => {
    expect(nextVersion('1.0.0', ['v1.0.0', '1.0.0', '1.0.1'])).toBe('1.0.2');
  });
  it('compares versions numerically, not as text', () => {
    expect(nextVersion('1.0.0', ['v1.0.9', 'v1.0.10'])).toBe('1.0.11');
  });
  it('releases a minor or major the maintainer set in package.json', () => {
    expect(nextVersion('1.1.0', ['v1.0.7'])).toBe('1.1.0');
    expect(nextVersion('2.0.0', ['v1.4.2'])).toBe('2.0.0');
  });
  it('patches once the declared version is released', () => {
    expect(nextVersion('1.1.0', ['v1.0.7', 'v1.1.0'])).toBe('1.1.1');
  });
  it('ignores prereleases and other tags', () => {
    expect(nextVersion('1.0.0', ['v1.0.3', 'v2.0.0-rc.1', 'vnext'])).toBe('1.0.4');
  });
  it('rejects a package.json version that is not MAJOR.MINOR.PATCH', () => {
    expect(() => nextVersion('1.0', [])).toThrow();
  });
});

describe('release notes', () => {
  const report = (fillRates: Report['fillRates']): Report => ({
    startedAt: '2026-11-27T10:00:00Z',
    finishedAt: '2026-11-27T10:05:00Z',
    small: true,
    requests: 40,
    passed: true,
    failures: [],
    notices: [],
    fillRates,
  });

  it('names the runtimes and lists the fill rates', () => {
    const notes = releaseNotes({ node: report({ beds: 0.8, location: 1 }), deno: report(null) });
    expect(notes).toContain('on deno, node before it was published');
    expect(notes).toContain('| beds | 80% |');
    expect(notes).toContain('| location | 100% |');
  });
  it('leaves out fill rates with too few listings to judge', () => {
    // JSON turns NaN into null.
    const notes = releaseNotes({ node: report({ beds: null as unknown as number }) });
    expect(notes).not.toContain('beds');
  });
});
