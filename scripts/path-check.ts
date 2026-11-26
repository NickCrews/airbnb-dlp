/**
 * The path-allowlist check: fails when a change touches a protected path.
 * `node scripts/path-check.ts <base-ref> [head-ref]`. On a public repository
 * this required check is the real enforcement, since push rulesets that
 * restrict file paths need a private repository on a paid plan.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;

export function protectedPatterns(): string[] {
  return JSON.parse(readFileSync(`${root}contract/protected-paths.json`, 'utf8')).protected as string[];
}

export function isProtected(path: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/** Paths a diff touches, renames counted at both ends. */
export function changedPaths(base: string, head: string): string[] {
  const out = execFileSync('git', ['diff', '--name-status', '-M', `${base}...${head}`], { cwd: root, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.split('\t').slice(1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) throw new Error('usage: path-check.ts <base-ref> [head-ref]');
  // The patterns come from the base, so a change cannot loosen its own check.
  const patterns = JSON.parse(execFileSync('git', ['show', `${base}:contract/protected-paths.json`], { cwd: root, encoding: 'utf8' })).protected as string[];
  const touched = changedPaths(base, head).filter((p) => isProtected(p, patterns));
  if (touched.length > 0) {
    console.error('This change touches maintainer-only paths:');
    for (const p of touched) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('no protected paths touched');
}
