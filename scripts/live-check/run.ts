/**
 * The live check: runs every product against airbnb.com and decides whether
 * the library still works. `pnpm live-check [--small] [--package <dir>] [--history <dir>] [--out <dir>]`.
 *
 * --small    the pull-request set: one area, fewer samples.
 * --package  an installed airbnb-dlp package (its directory under node_modules)
 *            to check instead of this checkout's src/. The release workflow
 *            checks the packed tarball this way before publishing it.
 * --history  reports from earlier runs (one JSON per run), for baselines and persistence.
 * --out      where to write report.json, log.txt and, on failure, recordings.json.gz.
 *
 * Exit code 0 when every check passes, 1 otherwise. The report names each
 * failure's category; file-issues.ts turns it into issues.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { bookableStays, createClient } from '../../src/entry-native.ts';
import { impitTransport } from '../../src/transport/impit.ts';
import { type Library, liveCheck } from './check.ts';
import { loadHistory } from './contract.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = flag('--out') ?? '.live-check';

/**
 * Loads a built package by file path. impitTransport is not a public export,
 * but the package ships it in dist/, so the check runs the transport users get.
 */
async function loadPackage(dir: string): Promise<Library> {
  const url = (path: string) => pathToFileURL(resolve(dir, path)).href;
  const entry = await import(url('dist/entry-native.js'));
  const transport = await import(url('dist/transport/impit.js'));
  return { createClient: entry.createClient, bookableStays: entry.bookableStays, impitTransport: transport.impitTransport };
}

const packageDir = flag('--package');
const { report, recordings, log } = await liveCheck({
  lib: packageDir ? await loadPackage(packageDir) : { createClient, bookableStays, impitTransport },
  small: args.includes('--small'),
  history: loadHistory(flag('--history')),
});
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) writeFileSync(join(outDir, 'recordings.json.gz'), gzipSync(JSON.stringify(recordings)));
console.log(`Wrote ${join(outDir, 'report.json')}${report.passed ? '' : ` and ${join(outDir, 'recordings.json.gz')}`}.`);
writeFileSync(join(outDir, 'log.txt'), `${log.join('\n')}\n`);
process.exitCode = report.passed ? 0 : 1;
