// Builds the desktop renderer as a plain web page (dist/xbase-ui) for the HRM legacy site to embed in an iframe.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web-ui',
  base: './',
  build: {
    outDir: '../../dist/xbase-ui',
    emptyOutDir: true,
    target: 'es2019',
    sourcemap: false,
    rollupOptions: {
      output: { entryFileNames: 'app.js', chunkFileNames: 'chunk-[name].js', assetFileNames: '[name][extname]' },
    },
  },
  worker: { format: 'iife', rollupOptions: { output: { entryFileNames: 'worker-[name].js' } } },
});
