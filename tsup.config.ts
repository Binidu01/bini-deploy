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
  outDir: 'dist',
  external: [
    '@inquirer/prompts',  
    'chalk',
    'cross-spawn',
    'ora',
  ],
  esbuildOptions(options) {
    options.banner = {
      js: '#!/usr/bin/env node\n',
    };
    return options;
  },
});