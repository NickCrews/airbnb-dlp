/**
 * Prints one fact about a drill scenario for the workflow:
 * `node scripts/drill/scenario-info.ts <scenario> expect|env`.
 * `env` prints KEY=value pairs for the live check, one per line.
 */
import { SCENARIOS } from './scenarios.ts';

const [name = '', field] = process.argv.slice(2);
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`unknown scenario "${name}"`);
if (field === 'expect') console.log(scenario.expect);
else if (field === 'env') for (const [k, v] of Object.entries(scenario.env ?? {})) console.log(`${k}=${v}`);
else throw new Error('field must be expect or env');
