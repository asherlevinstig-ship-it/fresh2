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
                // FIX: Point @colyseus/sdk to its browser distribution
                // This bypasses Node.js dependencies like 'httpie'
                // ------------------------------------------------------------
                '@colyseus/sdk': resolve(__dirname, 'node_modules/@colyseus/sdk/dist/colyseus.js'),
                
                // Keep these just in case other dependencies reference them
                'colyseus.js': resolve(__dirname, 'node_modules/@colyseus/sdk/dist/colyseus.js'),
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