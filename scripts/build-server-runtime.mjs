import { build } from 'esbuild';

await build({
  entryPoints: ['server/web-push.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/runtime/web-push.mjs',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  }
});

await build({
  entryPoints: ['server/ticket-push-worker.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/runtime/ticket-push-worker.mjs',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  }
});
