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
      this.emitFile({
        type: 'asset',
        fileName: 'runtime/web-push.mjs',
        source: readFileSync(new URL('./server/web-push.mjs', import.meta.url))
      });
      const appSource = readFileSync(new URL('./app-v2.js', import.meta.url), 'utf8');
      const logo = appSource.match(/<img src="data:image\/png;base64,([^"]+)"/);
      if (!logo) throw new Error('无法从主站提取 Cargo Pulse LOGO');
      this.emitFile({
        type: 'asset',
        fileName: 'brand-logo.png',
        source: Buffer.from(logo[1], 'base64')
      });
    }
  }]
};
