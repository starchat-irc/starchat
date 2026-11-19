import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

/** Left to the app's bundler, so a page that already has Alpine (e.g. through Livewire) keeps one instance. */
const external = Object.keys(pkg.dependencies ?? {});

export default defineConfig({
    build: {
        lib: {
            entry: 'src/index.js',
            formats: ['es'],
            fileName: 'starchat',
        },
        rollupOptions: {
            external: (id) => external.some((name) => id === name || id.startsWith(`${name}/`)),
        },
        sourcemap: true,
    },
    test: {
        include: ['test/**/*.test.js'],
        environment: 'node',
    },
});
