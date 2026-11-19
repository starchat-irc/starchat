import { defineConfig } from 'vite';

/**
 * Static demo page (getstarchat.net/demo). Unlike the library build it bundles its
 * dependencies, the output runs on any static host.
 */
export default defineConfig({
    root: 'demo',
    base: './',
    build: {
        outDir: '../dist-demo',
        emptyOutDir: true,
        // One bundle with Alpine and Bootstrap, about 140 kB gzipped
        chunkSizeWarningLimit: 800,
    },
});
