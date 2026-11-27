/**
 * Writes the top of a release's notes from the live-check reports of the
 * packed tarball: when it was checked against airbnb.com, on which runtimes,
 * and the fill rates. GitHub appends the list of merged pull requests.
 *
 * `node scripts/release/notes.ts <reports dir>`, where the directory holds
 * `live-check-report-<runtime>/report.json`, as `actions/download-artifact`
 * lays them out.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from '../live-check/contract.ts';

export function releaseNotes(reports: Record<string, Report>): string {
  const runtimes = Object.keys(reports).sort();
  const lines: string[] = [];
  const passed = runtimes.filter((r) => reports[r]!.passed);
  const finished = runtimes.map((r) => reports[r]!.finishedAt).sort().at(-1);
  lines.push(`This package was checked against airbnb.com on ${passed.join(', ')} before it was published (finished ${finished}).`);
  const rates = reports['node']?.fillRates ?? reports[runtimes[0]!]?.fillRates;
  if (rates) {
    const rows = Object.entries(rates)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
      .sort(([a], [b]) => a.localeCompare(b));
    if (rows.length > 0) {
      lines.push('', '| Field | Fill rate |', '|---|---|');
      for (const [field, rate] of rows) lines.push(`| ${field} | ${(rate * 100).toFixed(0)}% |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function loadReports(dir: string): Record<string, Report> {
  const reports: Record<string, Report> = {};
  for (const name of readdirSync(dir)) {
    const runtime = /^live-check-report-(.+)$/.exec(name)?.[1];
    const path = join(dir, name, 'report.json');
    if (runtime && existsSync(path)) reports[runtime] = JSON.parse(readFileSync(path, 'utf8')) as Report;
  }
  return reports;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node scripts/release/notes.ts <reports dir>');
  process.stdout.write(releaseNotes(loadReports(dir)));
}
