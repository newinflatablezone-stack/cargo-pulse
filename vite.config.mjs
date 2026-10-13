import { readFileSync } from 'node:fs';

export default {
  plugins: [{
    name: 'cargo-pulse-runtime-assets',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'runtime/ticket-service.mjs',
        source: readFileSync(new URL('./server/ticket-service.mjs', import.meta.url))
      });
    }
  }]
};
