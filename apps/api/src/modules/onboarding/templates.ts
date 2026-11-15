import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const templateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  accounts: z.array(
    z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(160),
      type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
      parent: z.string().nullable().optional(),
    }),
  ),
  categories: z.array(
    z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(120),
      kind: z.enum(['fee', 'tax', 'interest', 'transfer', 'revenue', 'expense', 'other']),
      account: z.string().nullable().optional(),
    }),
  ),
});

export type ChartTemplate = z.infer<typeof templateSchema>;

/** `TEMPLATES_DIR`, quando definida; senão, a pasta `config/templates` mais próxima acima deste arquivo. */
export function templatesDir(): string {
  const fromEnv = process.env.TEMPLATES_DIR;
  if (fromEnv) return resolve(fromEnv);
  let current = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 10; level += 1) {
    const candidate = join(current, 'config', 'templates');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd(), 'config', 'templates');
}

/** Lê e valida um modelo; devolve nulo quando não existe. */
export async function loadTemplate(name: string): Promise<ChartTemplate | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(name)) return null;
  let content: string;
  try {
    content = await readFile(join(templatesDir(), `${name}.json`), 'utf8');
  } catch {
    return null;
  }
  return templateSchema.parse(JSON.parse(content));
}
