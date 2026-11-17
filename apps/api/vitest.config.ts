import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/setup/global.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Cada arquivo cria as próprias empresas; o banco é compartilhado, então os arquivos rodam em série.
    fileParallelism: false,
  },
});
