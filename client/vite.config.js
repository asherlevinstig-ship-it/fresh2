import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig(({ command, mode, ssrBuild }) => {

    if (mode === 'production') {
        // production-specific config hooks can go here
    }

    return {

        // Vite serves from src/
        root: './src',

        // relative paths for assets
        base: './',

       resolve: {
    extensions: ['.js'],
    alias: {
        // Force Vite/Rollup to NOT pick the Node build of httpie
        '@colyseus/httpie/node': '@colyseus/httpie',

        // (Optional but harmless) Sometimes packages import with explicit file paths
        '@colyseus/httpie/node/index.mjs': '@colyseus/httpie',
    },
    dedupe: [
        // This is needed if importing noa-engine from the local filesystem,
        // but doesn't hurt anything if you're importing normally.
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
  outDir: '../dist',          // <-- IMPORTANT (goes to client/dist)
  emptyOutDir: true,          // ok because it's outside root
  chunkSizeWarningLimit: 1200,
  minify: true,
  rollupOptions: {
    input: {
      index: resolve(__dirname, 'src/index.html'),
      test: resolve(__dirname, 'src/test/index.html'),
      stress: resolve(__dirname, 'src/stress/index.html'),
      helloWorld: resolve(__dirname, 'src/hello-world/index.html'),
    },
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
