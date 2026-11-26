import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scripts/drill/scenarios.ts';
import { drillBranchLine, parseDrillBranch } from '../scripts/live-check/file-issues.ts';
import { isProtected, protectedPatterns } from '../scripts/path-check.ts';

describe('drill scenarios', () => {
  // A scenario whose edit no longer matches the code would make every drill of it fail at setup.
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    for (const edit of scenario.edits) {
      it(`${name} still applies to ${edit.file}`, () => {
        const text = readFileSync(new URL(`../${edit.file}`, import.meta.url), 'utf8');
        expect(text.split(edit.from).length - 1).toBe(1);
      });
    }
  }
  it('code scenarios go to the agent and simulated blocks to the maintainer', () => {
    for (const s of Object.values(SCENARIOS)) expect(s.agent).toBe(s.edits.length > 0);
  });
});

describe('drill issues', () => {
  it('name the repair branch in a line the agent workflow reads back', () => {
    expect(parseDrillBranch(`text\n\n${drillBranchLine('drill/123456')}\n`)).toBe('drill/123456');
    expect(parseDrillBranch(drillBranchLine('main'))).toBeNull();
    expect(parseDrillBranch('Repair branch: `drill/x; rm -rf /`')).toBeNull();
  });
  it('the drill scripts are maintainer-only', () => {
    expect(isProtected('scripts/drill/scenarios.ts', protectedPatterns())).toBe(true);
  });
});
