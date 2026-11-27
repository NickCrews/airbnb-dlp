/**
 * Combines machines' benchmark results into one and applies the bar in
 * contract/benchmark.json. The Benchmark workflow runs it over its runners'
 * outputs; it reads one local run just as well.
 *
 *   pnpm benchmark:merge <dir|benchmark.json>... [--reference <merged benchmark.json>] [--out <dir>]
 *
 * Directories are searched for benchmark.json files. --reference is an
 * earlier merged result for a working main, used when the base fails its own
 * live check. --out (default .benchmark/merged) gets benchmark.json and
 * summary.md. Exit code 1 when the verdict is a fail.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type MachineResult, type MergedResult, loadBenchmarkContract, merge, mergedSummary } from './lib.ts';

const args = process.argv.slice(2);
const valued = new Set(['--reference', '--out']);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const inputs = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
if (inputs.length === 0) throw new Error('usage: merge.ts <dir|benchmark.json>... [--reference <file>] [--out <dir>]');

function find(path: string): string[] {
  if (!existsSync(path)) throw new Error(`no such file or directory: ${path}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (statSync(child).isDirectory()) return find(child);
    return name === 'benchmark.json' ? [child] : [];
  });
}

const machines = inputs
  .flatMap((p) => find(resolve(p)))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')) as MachineResult | MergedResult)
  // A merged result found among the inputs contributes its machines.
  .flatMap((r) => ('machines' in r ? r.machines : [r]))
  .sort((a, b) => a.label.localeCompare(b.label));
if (machines.length === 0) throw new Error('no benchmark.json found in the inputs');
const referencePath = flag('--reference');
const reference = referencePath ? (JSON.parse(readFileSync(referencePath, 'utf8')) as MergedResult) : undefined;

const merged = merge(machines, loadBenchmarkContract(), reference);
const outDir = resolve(flag('--out') ?? '.benchmark/merged');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'benchmark.json'), `${JSON.stringify(merged, null, 2)}\n`);
const summary = mergedSummary(merged);
writeFileSync(join(outDir, 'summary.md'), summary);
console.log(summary);
process.exitCode = merged.verdict.pass ? 0 : 1;
