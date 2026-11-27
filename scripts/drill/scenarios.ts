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
   * What the agent, which gets every issue, should do: `repair` opens a pull
   * request; `no-repair` answers on the issue (closes it, or hands it to the
   * maintainer) and opens none.
   */
  outcome: 'repair' | 'no-repair';
  /** Edits to the code, as exact replacements; none for a scenario simulated at the transport. */
  edits: { file: string; from: string; to: string }[];
  /** Environment for the live check. */
  env?: Record<string, string>;
}

export const SCENARIOS: Record<string, Scenario> = {
  'stale-hash': {
    description: 'Airbnb rotated the persisted-query hash for reviews',
    expect: 'RequestRejected',
    outcome: 'repair',
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
    outcome: 'repair',
    edits: [
      {
        file: 'src/products/calendar.ts',
        from: "const date = day['calendarDate'];",
        to: "const date = day['calendarDay'];",
      },
    ],
  },
  blocked: {
    // The block is simulated in the drill's live check only, so the agent's own
    // live run does not reproduce it; nothing in the code needs fixing.
    description: 'Airbnb rate-limits the runner',
    expect: 'Blocked',
    outcome: 'no-repair',
    edits: [],
    env: { LIVE_CHECK_SIMULATE: 'blocked' },
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
