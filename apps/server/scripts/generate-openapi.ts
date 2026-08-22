import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SqliteRgapStore } from '@rgap/sqlite';
import { createApp } from '../src/app';

const store = new SqliteRgapStore();

try {
  const response = await createApp({ store, adminToken: 'openapi-generation-only' })
    .request('/openapi.json');
  if (!response.ok) throw new Error(`OpenAPI generation failed with status ${response.status}.`);
  const output = `${JSON.stringify(await response.json(), null, 2)}\n`;
  await writeFile(fileURLToPath(new URL('../openapi.json', import.meta.url)), output);
} finally {
  store.close();
}
