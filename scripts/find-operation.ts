/**
 * Finds a GraphQL operation's current persisted-query hash in airbnb.com's
 * JavaScript: `pnpm find-operation <OperationName> [--max-chunks <n>]`.
 *
 * Many operations live in chunks a page loads only on demand, such as the
 * reviews modal's, so the page's own <script> tags do not include them. This
 * reads the homepage (one request to airbnb.com, through the library's
 * transport) for its asyncRequire bundle, which lists every chunk, then
 * fetches the chunks whose paths best match the operation's name from the
 * static CDN and searches them for
 * `name:'<Operation>',type:'query',operationId:'<hash>'`. When none of those
 * has it, it searches the shared chunks, whose names are hashes, too: about
 * 500 files from the CDN, eight at a time, stopping at the first match.
 *
 * Prints the hash and the chunk it came from, or the closest names found.
 * Exit code 1 when the operation is not found.
 */
import { impitTransport } from '../src/transport/impit.ts';
import { HTML_HEADERS } from '../src/identity.ts';

const [operation, ...rest] = process.argv.slice(2);
if (!operation || operation.startsWith('--')) throw new Error('usage: find-operation.ts <OperationName> [--max-chunks <n>]');
const i = rest.indexOf('--max-chunks');
const maxChunks = i >= 0 ? Number(rest[i + 1]) : 200;

const CDN = 'https://a0.muscache.com/airbnb/static/packages/web/';
const OPERATION_RE = /name:'([A-Za-z0-9_]+)',type:'(query|mutation)',operationId:'([0-9a-f]{64})'/g;

async function cdn(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.text();
}

/** The operation name's words: StaysPdpReviewsQuery is stays, pdp, reviews. */
function words(name: string): string[] {
  return name
    .replace(/(Query|Mutation)$/, '')
    .split(/(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1);
}

const homepage = await impitTransport()(
  { method: 'GET', url: 'https://www.airbnb.com/?locale=en', headers: { ...HTML_HEADERS }, body: null },
  new AbortController().signal,
);
if (homepage.status !== 200) throw new Error(`the homepage answered ${homepage.status}`);
const scripts = [...new Set([...homepage.body.matchAll(/https:\/\/a0\.muscache\.com\/airbnb\/static\/packages\/web\/[^"' ]+?\.js/g)].map((m) => m[0]))];
const asyncRequire = scripts.find((s) => /\/asyncRequire\.[0-9a-f]+\.js$/.test(s));
if (!asyncRequire) throw new Error('the homepage loads no asyncRequire bundle, so the chunk list is unknown');
const manifest = await cdn(asyncRequire);
const chunks = [...new Set([...manifest.matchAll(/"((?:en|common)\/frontend\/[A-Za-z0-9_/.-]+\.js)"/g)].map((m) => m[1]!))];
console.log(`${chunks.length} chunks listed in ${asyncRequire.slice(CDN.length)}`);

// The chunks whose paths share the most words with the operation's name come
// first, a word in the file's own name counting double: PdpPlatformRoute.js
// before a file in a pdp/ directory.
const want = words(operation);
const score = (path: string) => {
  const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dirs = path.slice(0, path.lastIndexOf('/')).toLowerCase();
  return want.reduce((n, w) => n + (file.includes(w) ? 2 : 0) + (dirs.includes(w) ? 1 : 0), 0);
};
// The homepage's own bundles first: they hold the operations every page uses.
const pageChunks = scripts.filter((s) => s.startsWith(CDN)).map((s) => s.slice(CDN.length));
const scored = [...pageChunks.map((path) => ({ path, score: Infinity })), ...chunks.filter((c) => !pageChunks.includes(c)).map((path) => ({ path, score: score(path) }))]
  .filter((c) => c.score > 0)
  .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  .slice(0, maxChunks);
console.log(`searching ${scored.length} chunks matching ${want.join(', ')}`);

const near = new Map<string, string>();
/** Searches one chunk; exits the process when it holds the operation. */
async function search(path: string): Promise<void> {
  let text: string;
  try {
    text = await cdn(CDN + path);
  } catch (error) {
    console.log(`  skipped ${path}: ${String(error)}`);
    return;
  }
  for (const [, name, type, hash] of text.matchAll(OPERATION_RE)) {
    if (name === operation) {
      console.log(`\n${operation} (${type}): ${hash}\n  in ${CDN}${path}`);
      process.exit(0);
    }
    if (want.some((w) => name!.toLowerCase().includes(w))) near.set(name!, `${hash} in ${path}`);
  }
}
async function searchAll(paths: string[], parallel: number): Promise<void> {
  const queue = [...paths];
  await Promise.all(Array.from({ length: parallel }, async () => {
    for (let path = queue.shift(); path; path = queue.shift()) await search(path);
  }));
}

await searchAll(scored.map((c) => c.path), 4);
const shared = [...new Set([...manifest.matchAll(/"((?:en|common)\/[0-9a-f]{4}\.[0-9a-f]{10}\.js)"/g)].map((m) => m[1]!))].filter((p) => !pageChunks.includes(p));
console.log(`not in the named chunks; searching ${shared.length} shared chunks`);
await searchAll(shared, 8);
console.log(`\n${operation} not found in ${scored.length + shared.length} chunks.`);
if (near.size > 0) {
  console.log('Operations with similar names, in case it was renamed:');
  for (const [name, where] of near) console.log(`  ${name}: ${where}`);
}
process.exitCode = 1;
