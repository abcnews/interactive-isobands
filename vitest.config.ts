import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests don't load the aunty build plugins; lib code is plain TypeScript.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] }
});
