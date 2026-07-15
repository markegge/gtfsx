// Vitest config for frontend service tests (src/**/__tests__/*.test.ts).
//
// The default vitest.config.ts runs in the Cloudflare workers pool — that's
// right for the Worker but breaks frontend code that relies on Vite's
// `import.meta.env` and standard Node fetch semantics. This config uses the
// default node environment and a dedicated test glob.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'src/services/accessIsochrone/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
