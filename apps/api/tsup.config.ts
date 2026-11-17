import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', 'worker-main': 'src/worker-main.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // O domínio é código do próprio repositório e entra no pacote; dependências de terceiros ficam externas.
  noExternal: ['@concilia/core'],
});
