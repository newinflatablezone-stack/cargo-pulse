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
      const pageSource = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
      const logo = pageSource.match(/<link rel="icon" type="image\/png" href="data:image\/png;base64,([^"]+)"/);
      if (!logo) throw new Error('无法从主站提取 Cargo Pulse LOGO');
      this.emitFile({
        type: 'asset',
        fileName: 'brand-logo.png',
        source: Buffer.from(logo[1], 'base64')
      });
    }
  }]
};
