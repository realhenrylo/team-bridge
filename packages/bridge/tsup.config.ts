import { defineConfig } from 'tsup';

// Build once; scripts/package-plugins.mjs distributes the self-contained bundle
// to both host packages. Hooks run frequently, so startup must stay cheap.
export default defineConfig({
  entry: { 'team-bridge': 'src/cli.ts' },
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  outExtension: () => ({ js: '.cjs' }),
  noExternal: [/.*/],
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: true,
  clean: false,
  minify: false,
});
