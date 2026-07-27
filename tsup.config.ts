import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  banner: {
    js: '#!/usr/bin/env node\n',
  },
  outDir: 'dist',
  external: [
    'chalk',
    'cross-spawn',
    'inquirer',
    'ora',
  ],
  noExternal: [
    // Any packages you want to bundle instead of keeping external
  ],
  esbuildOptions(options) {
    // Ensure the banner is applied correctly
    options.banner = {
      js: '#!/usr/bin/env node\n',
    };
  },
});