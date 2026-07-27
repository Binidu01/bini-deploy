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
  esbuildOptions(options) {
    options.banner = {
      js: '#!/usr/bin/env node\n',
    };
  },
  outDir: 'dist',
  external: [
    'chalk',
    'cross-spawn',
    'inquirer',
    'ora',
    'fs',
    'path',
    'url',
    'child_process',
  ],
});