import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Test files and test support are the measuring instrument, not the measured surface.
      exclude: ['src/**/*.test.ts', 'src/fixture.ts'],
      // Show every file that has statements to measure; a types-only or re-export file has none.
      reporter: [['text', { skipFull: false, skipEmpty: true }]],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
