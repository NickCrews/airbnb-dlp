import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Fixture } from './fixture-suite.ts';

export function loadFixtures(): Fixture[] {
  const root = new URL('../fixtures/', import.meta.url);
  const fixtures: Fixture[] = [];
  for (const dir of readdirSync(root)) {
    if (!statSync(new URL(dir, root)).isDirectory()) continue;
    // Only fixtures: an editor's or OS's stray files (.DS_Store) are not one.
    for (const file of readdirSync(new URL(`${dir}/`, root)).filter((f) => f.endsWith('.json.gz'))) {
      fixtures.push(JSON.parse(gunzipSync(readFileSync(new URL(`${dir}/${file}`, root))).toString()));
    }
  }
  return fixtures;
}
