/**
 * Drill scenarios: each breaks the code the way an upstream change would, so
 * the live check and the repair agent face a real disagreement between the
 * code and airbnb.com.
 */
import type { ErrorCategory } from '../../src/errors.ts';

export interface Scenario {
  /** What the drill simulates, for the run summary. */
  description: string;
  /** The category the live check must report. */
  expect: ErrorCategory;
  /**
   * Edits to the code. `from` is exact text, or a pattern for a value a repair
   * may since have changed; either must match exactly once.
   */
  edits: { file: string; from: string | RegExp; to: string }[];
}

/** Occurrences of an edit's `from` in a file's text. */
export function matches(text: string, from: string | RegExp): number {
  return typeof from === 'string' ? text.split(from).length - 1 : (text.match(new RegExp(from.source, 'g')) ?? []).length;
}

export const SCENARIOS: Record<string, Scenario> = {
  'stale-hash': {
    description: 'Airbnb rotated the persisted-query hash for reviews',
    expect: 'RequestRejected',
    edits: [
      {
        file: 'src/airbnb.ts',
        from: "StaysPdpReviewsQuery: 'cfdc3ffbe997a618795fc5a8f9a9b484054ce9be68c8788cd2ffda999934c5ae',",
        to: "StaysPdpReviewsQuery: '5b0e5fd2a8c9f7c9e3b1d4a6f80c2e71b9d3a5c7e9f1b3d5a7c9e1f3b5d7a9c1',",
      },
    ],
  },
  'parser-break': {
    description: "Airbnb renamed a calendar day's date field",
    expect: 'ResponseChanged',
    edits: [
      {
        file: 'src/products/calendar.ts',
        from: "const date = day['calendarDate'];",
        to: "const date = day['calendarDay'];",
      },
    ],
  },
  blocked: {
    // Real throughput against airbnb.com, at the library's defaults, which the
    // live check runs at: Airbnb rate-limits it, and the repair is to lower
    // the pace again. The patterns match whatever pace a repair last set.
    description: 'The default pace went up past what Airbnb accepts',
    expect: 'Blocked',
    edits: [
      { file: 'src/identity.ts', from: /export const DEFAULT_REQUESTS_PER_SECOND = [0-9.]+;/, to: 'export const DEFAULT_REQUESTS_PER_SECOND = 20;' },
      { file: 'src/identity.ts', from: /export const DEFAULT_CONCURRENCY = [0-9]+;/, to: 'export const DEFAULT_CONCURRENCY = 16;' },
    ],
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
