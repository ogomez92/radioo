import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // The svelte plugin is needed so .svelte.ts files (runes) compile in tests.
  plugins: [svelte({ hot: false })],
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.{test,spec}.ts',
      'electron/**/*.{test,spec}.ts',
      'public/**/*.{test,spec}.ts',
    ],
    // Tests currently use top-level `describe`/`it` without importing them.
    globals: true,
  },
  resolve: {
    // Treat .svelte.ts files as runes-enabled TS so `$state`, `$derived`,
    // etc. are available under Vitest's jsdom env.
    conditions: ['browser'],
  },
});
