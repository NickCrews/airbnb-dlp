/**
 * Compiles src to dist. tsc rewrites relative `.ts` imports in JavaScript but
 * not in declarations, so declarations are rewritten to `.js` here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

export function build(outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.build.json'), '--outDir', outDir], { stdio: 'inherit' });
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.d.ts')) {
        const text = readFileSync(path, 'utf8').replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, '$1$2.js$1');
        writeFileSync(path, text);
      }
    }
  };
  walk(outDir);
}

if (import.meta.url === `file://${process.argv[1]}`) build(join(root, 'dist'));
