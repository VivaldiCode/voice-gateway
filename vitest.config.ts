import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: [
      'tests/e2e/**',
      'node_modules/**',
      'out/**',
      'release/**',
      '**/._*',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/shared/**/*.ts', 'src/main/services/**/*.ts'],
      // Type-only declaration files contain no runtime statements — V8 reports
      // them as 0% which would drag the suite-wide number down misleadingly.
      // Excluded here rather than in include because future renames stay safe.
      exclude: ['src/shared/types.ts'],
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
});
