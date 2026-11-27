/**
 * The live check: runs every product against airbnb.com and decides whether
 * the library still works. `pnpm live-check [--small] [--history <dir>] [--out <dir>]`.
 *
 * --small    the pull-request set: one area, fewer samples.
 * --history  reports from earlier runs (one JSON per run), for baselines and persistence.
 * --out      where to write report.json, log.txt and, on failure, recordings.json.gz.
 *
 * Exit code 0 when every check passes, 1 otherwise. The report names each
 * failure's category; file-issues.ts turns it into issues.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bookableStays, createClient } from '../../src/entry-native.ts';
import { impitTransport } from '../../src/transport/impit.ts';
import { liveCheck } from './check.ts';
import { loadHistory } from './contract.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = flag('--out') ?? '.live-check';
const { report, recordings, log } = await liveCheck({
  lib: { createClient, bookableStays, impitTransport },
  small: args.includes('--small'),
  history: loadHistory(flag('--history')),
});
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) writeFileSync(join(outDir, 'recordings.json.gz'), gzipSync(JSON.stringify(recordings)));
console.log(`Wrote ${join(outDir, 'report.json')}${report.passed ? '' : ` and ${join(outDir, 'recordings.json.gz')}`}.`);
writeFileSync(join(outDir, 'log.txt'), `${log.join('\n')}\n`);
process.exitCode = report.passed ? 0 : 1;
