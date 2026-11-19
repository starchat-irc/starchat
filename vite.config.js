import { defineConfig } from 'vitest/config';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/index.js',
            formats: ['es'],
            fileName: 'starchat',
        },
        sourcemap: true,
    },
    test: {
        include: ['test/**/*.test.js'],
        environment: 'node',
    },
});
