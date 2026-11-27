import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { type Fixture, replayFixture } from './fixture-suite.ts';

const root = new URL('../fixtures/', import.meta.url);
const files = readdirSync(root).flatMap((dir) =>
  statSync(new URL(dir, root)).isDirectory() ? readdirSync(new URL(`${dir}/`, root)).filter((f) => f.endsWith('.json.gz')).map((f) => `${dir}/${f}`) : [],
);

describe('fixtures', () => {
  it('exist', () => expect(files.length).toBeGreaterThan(0));
  it.each(files)('%s is gzip-compressed JSON and replays cleanly', async (file) => {
    expect(file.endsWith('.json.gz')).toBe(true);
    const fixture = JSON.parse(gunzipSync(readFileSync(new URL(file, root))).toString()) as Fixture;
    const { problems } = await replayFixture(fixture);
    expect(problems).toEqual([]);
  });
});
