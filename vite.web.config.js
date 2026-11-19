import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vite';

/**
 * Hostable web page (web/), released as starchat-web-*.zip and used for the demo on
 * getstarchat.net. Unlike the library build it bundles its dependencies, so the output
 * runs on any static host. config.json and favicon.svg come from web/public/, the push
 * service worker is copied from src/ so there is only one version of it.
 */
export default defineConfig({
    root: 'web',
    base: './',
    build: {
        outDir: '../dist-web',
        emptyOutDir: true,
        // One bundle with Alpine and Bootstrap, about 140 kB gzipped
        chunkSizeWarningLimit: 800,
    },
    plugins: [{
        name: 'starchat-push-worker',
        async generateBundle() {
            this.emitFile({ type: 'asset', fileName: 'push-sw.js', source: await readFile('src/push-sw.js', 'utf8') });
        },
        configureServer(server) {
            server.middlewares.use('/push-sw.js', async (request, response) => {
                response.setHeader('Content-Type', 'text/javascript');
                response.end(await readFile('src/push-sw.js', 'utf8'));
            });
        },
    }],
});
