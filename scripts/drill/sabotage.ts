/**
 * Applies a drill scenario's code edits to the working tree:
 * `node scripts/drill/sabotage.ts <scenario>`. Fails when an edit no longer
 * applies, so a drill never runs against code it did not break.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SCENARIOS, SCENARIO_NAMES } from './scenarios.ts';

const name = process.argv[2] ?? '';
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`unknown scenario "${name}"; expected one of ${SCENARIO_NAMES.join(', ')}`);
const root = new URL('../../', import.meta.url);
for (const { file, from, to } of scenario.edits) {
  const path = new URL(file, root);
  const text = readFileSync(path, 'utf8');
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`scenario ${name}: expected the text once in ${file}, found it ${count} times; update scripts/drill/scenarios.ts`);
  writeFileSync(path, text.replace(from, to));
  console.log(`edited ${file}`);
}
