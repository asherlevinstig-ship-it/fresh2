import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig(({ command, mode }) => {
    return {
        root: './src',
        base: './',

        resolve: {
            extensions: ['.js', '.ts', '.json'],
            alias: {
                // ------------------------------------------------------------
                // FIX: Use absolute path to bypass package 'exports' restriction
                // This forces the browser bundle to load
                // ------------------------------------------------------------
                'colyseus.js': resolve(__dirname, 'node_modules/colyseus.js/dist/colyseus.js'),
                
                // Fallbacks for nested dependencies if they still misbehave
                '@colyseus/httpie/node': '@colyseus/httpie',
                
                // Babylon Legacy Fix
                babylonjs: '@babylonjs/core/Legacy/legacy',
            },
            dedupe: ['@babylonjs/core'],
        },

        build: {
            target: 'es2020',
            outDir: '../dist',
            emptyOutDir: true,
            minify: true,
            rollupOptions: {
                input: resolve(__dirname, 'src/index.html'),
                manualChunks: (id) => {
                    if (id.includes('@babylon') || id.includes('babylonjs')) return 'babylon'
                },
            },
        },
    }
})