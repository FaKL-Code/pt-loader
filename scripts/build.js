import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: {
    index: 'src/index.js',
    core: 'src/core.js',
    viewer: 'src/viewer.js',
    'worker/parse.worker': 'src/worker/parse.worker.js',
    cli: 'bin/cli.js',
  },
  outdir: 'dist',
  absWorkingDir: process.cwd(),
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  format: 'esm',
  platform: 'neutral',
  packages: 'external',
  target: 'es2020',
});
