import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildDemoFiles } from './files';

// Grava os arquivos fictícios em demo/files/ na raiz do repositório.
// Uso: pnpm --filter @concilia/api exec tsx src/demo/write-files.ts
const outDir = fileURLToPath(new URL('../../../../demo/files/', import.meta.url));

await mkdir(outDir, { recursive: true });
const files = await buildDemoFiles();
for (const file of files) {
  await writeFile(`${outDir}${file.name}`, file.content);
  console.log(`${file.name} (${file.content.length} bytes)`);
}
