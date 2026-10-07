// Bundles the planning sources for node:test. esbuild (not tsc) so runtime imports
// from workspace packages (e.g. @apm/domain's TRACK_DISPLAY_NAMES) resolve from TS
// source on every supported Node version.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts', methodology: 'src/methodology.ts', recurrence: 'src/recurrence.ts' },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outdir: '.test-dist',
  logLevel: 'error',
});
