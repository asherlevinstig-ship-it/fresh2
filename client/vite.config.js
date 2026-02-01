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
            alias: {},
            dedupe: [
                // Needed if importing noa-engine from local filesystem
                // Safe even when importing normally
                '@babylonjs/core',
            ],
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
