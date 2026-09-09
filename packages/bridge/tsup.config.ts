import { defineConfig } from 'tsup';

// Single-file CJS bundle copied straight into the plugin so the plugin dir is
// self-contained. Hooks run on every tool round, so startup must stay cheap.
export default defineConfig({
  entry: { 'team-bridge': 'src/cli.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  outDir: '../../plugin/dist',
  outExtension: () => ({ js: '.cjs' }),
  noExternal: [/.*/],
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: true,
  clean: false,
  minify: false,
});
