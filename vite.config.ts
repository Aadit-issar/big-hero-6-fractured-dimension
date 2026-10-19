import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves the project at /<repo>/; the deploy workflow sets VITE_BASE.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Terrain tests mesh all fourteen islands; allow for a loaded CPU.
    testTimeout: 30_000,
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/simulation/**/*.ts'],
    },
  },
});
