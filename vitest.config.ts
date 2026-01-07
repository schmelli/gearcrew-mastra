import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/'],
    },
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      '@/lib': path.resolve(__dirname, './src/lib'),
      '@/mastra': path.resolve(__dirname, './src/mastra'),
      '@/types': path.resolve(__dirname, './src/types'),
    },
  },
});
