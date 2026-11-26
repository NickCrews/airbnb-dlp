/** Bundles the fixture suite and runs it in headless Chromium. */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { loadFixtures } from './load-fixtures.ts';

const bundle = await build({
  stdin: {
    contents: "import { runFixtureSuite } from './fixture-suite.ts'; globalThis.runFixtureSuite = runFixtureSuite;",
    resolveDir: new URL('.', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
});
const executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const fixtures = loadFixtures();
  const problems: string[] = await page.evaluate((f) => (globalThis as any).runFixtureSuite(f), fixtures);
  for (const p of problems) console.error(p);
  console.log(`browser: ${fixtures.length} fixtures, ${problems.length} problems`);
  if (problems.length > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
