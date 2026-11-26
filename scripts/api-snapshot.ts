/**
 * The type-level API snapshot: the declarations of every public module,
 * compared with contract/api-snapshot.d.ts. `--update` rewrites the snapshot,
 * which is a contract change and needs the maintainer.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.ts';

/** The modules whose declarations make up the public surface. */
const PUBLIC = ['index', 'entry-native', 'public', 'types', 'errors', 'stays', 'reference', 'testing/index'];

const root = new URL('..', import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), 'api-snapshot-'));
try {
  build(out);
  const snapshot = PUBLIC.map((m) => `// ---- ${m}\n${readFileSync(join(out, `${m}.d.ts`), 'utf8').trim()}\n`).join('\n');
  const file = join(root, 'contract/api-snapshot.d.ts.txt');
  if (process.argv.includes('--update')) {
    writeFileSync(file, snapshot);
    console.log(`wrote ${file}`);
  } else {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // No snapshot yet: the comparison below fails.
    }
    if (current !== snapshot) {
      console.error('The public API differs from contract/api-snapshot.d.ts.txt. A contract change needs the maintainer: pnpm api-snapshot --update.');
      process.exit(1);
    }
    console.log('public API matches the snapshot');
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
