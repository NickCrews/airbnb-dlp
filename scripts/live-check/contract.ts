import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCategory } from '../../src/errors.ts';
import type { BBox } from '../../src/types.ts';

export interface Area {
  id: string;
  kind: 'dense' | 'rural' | 'hawaii' | 'alaska';
  bbox: BBox;
  minListings: number;
  registrationLaw: boolean;
}

export interface Thresholds {
  requestBudget: number;
  sampleListingsPerArea: number;
  fetchSuccessShare: { listings: number; calendars: number; priceQuotes: number; reviews: number };
  baselineDays: number;
  baselineTolerance: number;
  starting: {
    listingFields: Record<string, number>;
    bathroomsWhereHotelsDominate: number;
    bedroomsOfEntireHomes: number;
    exactLocationShare: { min: number; max: number };
    searchCardsWithPrice: number;
  };
  ranges: { nightlyPriceUsd: { min: number; max: number }; calendarMonths: number };
  coverage: { auditBoxes: number; maxMissShare: number };
  /** Sampled listings allowed per field whose Airbnb value the library maps to null. */
  maxUnrecognisedValues: number;
}

export interface Failure {
  category: ErrorCategory;
  check: string;
  /** Written by the live check: names and counts, safe to publish. */
  message: string;
  /** Error text, which may quote Airbnb's responses. Kept in the report artifact, never in issues. */
  detail?: string;
}

/** Field name to share of sampled listings with a value, overall and per area. */
export type FillRates = Record<string, number>;

export interface Report {
  startedAt: string;
  finishedAt: string;
  small: boolean;
  requests: number;
  passed: boolean;
  failures: Failure[];
  fillRates: FillRates | null;
}

const root = new URL('../../', import.meta.url).pathname;

export function loadContract(): { areas: Area[]; thresholds: Thresholds } {
  const areas = JSON.parse(readFileSync(join(root, 'contract/reference-areas.json'), 'utf8')).areas as Area[];
  const thresholds = JSON.parse(readFileSync(join(root, 'contract/thresholds.json'), 'utf8')) as Thresholds;
  return { areas, thresholds };
}

/** Every report.json under a directory, oldest first. */
export function loadHistory(dir: string | undefined): Report[] {
  if (!dir || !existsSync(dir)) return [];
  const reports: Report[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'report.json') reports.push(JSON.parse(readFileSync(path, 'utf8')));
    }
  };
  walk(dir);
  return reports.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** n items spread evenly through a list, so samples are not all from one corner. */
export function sampleEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items.slice();
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
}
