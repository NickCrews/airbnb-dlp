/** Runs the fixture suite on whichever runtime executes it: node, bun or deno. */
import { runFixtureSuite } from './fixture-suite.ts';
import { loadFixtures } from './load-fixtures.ts';

const fixtures = loadFixtures();
const problems = await runFixtureSuite(fixtures);
for (const p of problems) console.error(p);
console.log(`${fixtures.length} fixtures, ${problems.length} problems`);
if (problems.length > 0 || fixtures.length === 0) process.exit(1);
