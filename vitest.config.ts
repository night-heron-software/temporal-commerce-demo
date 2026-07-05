import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror the tsconfig `@/*` path alias so API-route tests can resolve production imports.
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', '.next'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // UI (pages/components/context) is excluded from coverage; API route handlers count.
      exclude: [
        'src/**/*.test.ts',
        'src/app/**/*.tsx',
        'src/app/{shop,admin,dev,docs}/**',
        'src/components/**',
        'src/context/**',
      ],
      reporter: ['text', 'html'],
    },
  },
});
