import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig(({ command, mode, ssrBuild }) => {
    if (mode === 'production') {
        // production-specific config hooks can go here
    }

    return {
        // Vite serves files from ./src
        root: './src',

        // Use relative paths for assets (handy for static hosting)
        base: './',

        // Module resolution rules
        resolve: {
            extensions: ['.js'],
            alias: {
                // Force Vite/Rollup to NOT pick the Node build of httpie
                '@colyseus/httpie/node': '@colyseus/httpie',

                // Sometimes packages import explicit file paths
                '@colyseus/httpie/node/index.mjs': '@colyseus/httpie',
            },
            dedupe: [
                // Needed if importing noa-engine from local filesystem,
                // safe even when importing normally
                '@babylonjs/core',
            ],

            // Prefer browser entry points when bundling for the web
            mainFields: ['browser', 'module', 'jsnext:main', 'jsnext'],

            // Prefer browser export conditions (prevents selecting "node" condition)
            conditions: ['browser', 'module', 'import', 'default'],
        },

        plugins: [],

        server: {
            port: 8080,
            host: '0.0.0.0',
        },

        // Production build configuration
        build: {
            target: 'es2020',

            // IMPORTANT:
            // Because `root` is "./src", outDir is relative to that.
            // "../dist" places output at "client/dist" (what Vercel expects).
            outDir: '../dist',

            // ok because build output is outside root dir
            emptyOutDir: true,

            // Babylon chunk for these demos is ~1.1MB
            chunkSizeWarningLimit: 1200,

            minify: true,

            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'src/index.html'),
                    test: resolve(__dirname, 'src/test/index.html'),
                    stress: resolve(__dirname, 'src/stress/index.html'),
                    helloWorld: resolve(__dirname, 'src/hello-world/index.html'),
                },

                // keep babylon in its own chunk
                manualChunks: (id) => {
                    if (id.includes('@babylon')) return 'babylon'
                },
            },
        },

        // Misc
        clearScreen: false,
        logLevel: 'info',
    }
})
