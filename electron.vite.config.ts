import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Default entries: src/main/index.ts, src/preload/index.ts, src/renderer/index.html
export default defineConfig({
  main: {
    // mssql and tedious are bundled into the main script, so no node_modules ship with the program.
    plugins: [externalizeDepsPlugin({ exclude: ['mssql'] })],
    resolve: {
      alias: {
        '@azure/identity': resolve('src/main/stubs/azure-identity.ts'),
        '@azure/core-auth': resolve('src/main/stubs/azure-core-auth.ts'),
      },
    },
  },
  preload: {},
  renderer: {},
});
