import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build for the SDK, so external agent developers can consume it
 * from either module system. Types are emitted alongside. `tsc --noEmit` handles
 * strict type-checking separately (see the `typecheck` script).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Dedicated build tsconfig disables `composite` (inherited from the monorepo
  // base), which the .d.ts builder cannot use without an explicit file list.
  tsconfig: 'tsconfig.build.json',
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
