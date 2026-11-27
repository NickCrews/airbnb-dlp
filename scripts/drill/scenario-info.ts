/**
 * Prints one fact about a drill scenario for the workflow:
 * `node scripts/drill/scenario-info.ts <scenario> expect`.
 */
import { SCENARIOS } from './scenarios.ts';

const [name = '', field] = process.argv.slice(2);
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`unknown scenario "${name}"`);
if (field === 'expect') console.log(scenario.expect);
else throw new Error('field must be expect');
