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
                '@colyseus/httpie/node/index.mjs': '@colyseus/httpie',

                // ------------------------------------------------------------
                // CRITICAL: ensure ALL "babylonjs" namespace imports resolve to
                // Babylon 6 core legacy build (single runtime)
                // ------------------------------------------------------------
                babylonjs: '@babylonjs/core/Legacy/legacy',
            },

            dedupe: [
                // Ensure single copy in the bundle graph
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
            outDir: '../dist',
            emptyOutDir: true,
            chunkSizeWarningLimit: 1200,
            minify: true,

            rollupOptions: {
                input: resolve(__dirname, 'src/index.html'),

                // keep babylon in its own chunk
                manualChunks: (id) => {
                    if (id.includes('@babylon') || id.includes('babylonjs')) return 'babylon'
                },
            },
        },

        // Misc
        clearScreen: false,
        logLevel: 'info',
    }
})
