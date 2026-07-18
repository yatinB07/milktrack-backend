import { mkdir, readFile, writeFile } from 'node:fs/promises';

import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

type CompiledApplication = {
  readonly createApp: (options: { logger: false }) => Promise<INestApplication>;
};

type CompiledOpenApi = {
  readonly createOpenApiDocument: (app: INestApplication) => OpenAPIObject;
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  );
}

const output = new URL('../openapi/v1.json', import.meta.url);
const [{ createApp }, { createOpenApiDocument }] = (await Promise.all([
  import(new URL('../dist/bootstrap/create-app.js', import.meta.url).href),
  import(new URL('../dist/bootstrap/configure-app.js', import.meta.url).href),
])) as [CompiledApplication, CompiledOpenApi];

const app = await createApp({ logger: false });
try {
  const serialized = `${JSON.stringify(sortKeys(createOpenApiDocument(app)), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const committed = await readFile(output, 'utf8').catch(() => '');
    if (committed !== serialized) {
      throw new Error('openapi/v1.json is out of date; run npm run openapi:generate');
    }
  } else {
    await mkdir(new URL('../openapi/', import.meta.url), { recursive: true });
    await writeFile(output, serialized);
  }
} finally {
  await app.close();
}
