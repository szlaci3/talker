import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.live.test.{ts,tsx}'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 15_000,
  },
});
