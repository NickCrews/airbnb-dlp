import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { Fixture } from './fixture-suite.ts';

export function loadFixtures(): Fixture[] {
  const root = new URL('../fixtures/', import.meta.url);
  const fixtures: Fixture[] = [];
  for (const dir of readdirSync(root)) {
    if (!statSync(new URL(dir, root)).isDirectory()) continue;
    for (const file of readdirSync(new URL(`${dir}/`, root))) {
      fixtures.push(JSON.parse(gunzipSync(readFileSync(new URL(`${dir}/${file}`, root))).toString()));
    }
  }
  return fixtures;
}
