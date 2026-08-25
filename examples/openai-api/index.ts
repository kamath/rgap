import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { ResourceHandle } from '@rgap/core';
import {
  createOpenAIProxyApp,
  createOpenAIProxyRuntime,
} from '@rgap/openai-proxy';
import { SqliteRgapStore } from '@rgap/store-sqlite';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 3004);
const providerModels = commaSeparated(
  process.env.OPENAI_MODELS ?? 'gpt-5.6-sol,gpt-5.6-luna',
);
const grantedModels = new Set(commaSeparated(
  process.env.GRANTED_OPENAI_MODELS ?? providerModels[0]!,
));

if (!providerModels.length) throw new Error('OPENAI_MODELS must contain at least one model.');
for (const model of grantedModels) {
  if (!providerModels.includes(model)) {
    throw new Error(`Granted model ${model} is not present in OPENAI_MODELS.`);
  }
}

const store = new SqliteRgapStore({
  url: `${directory}/rgap.db`,
  runtimes: { openai: createOpenAIProxyRuntime() },
});
const admin = store.admin();
await admin.reset();

const models = new Map<string, ResourceHandle>();
for (const modelName of providerModels) {
  const resource = await admin.resources.create({
    name: `models/openai/${modelName}`,
    executable: {
      runtime: 'openai',
      input: { model: modelName },
    },
  });
  models.set(modelName, resource);
}

const application = await admin.grants.create({
  name: 'company/product/openai-api-example',
  bindings: [...grantedModels].map((modelName) => ({
    id: models.get(modelName)!.id,
    permissions: ['invoke'] as const,
  })),
  expiresAt: null,
});
const bearer = await application.tokens.create({ label: 'local-client' });
const tokenPath = `${directory}/client.token`;
writeFileSync(tokenPath, bearer.value, { mode: 0o600 });

const app = createOpenAIProxyApp({
  store,
  models: new Map(
    [...models].map(([name, resource]) => [name, resource.id]),
  ),
});

const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`OpenAI-compatible API listening on http://localhost:${listeningPort}/v1`);
  console.log(`RGAP bearer written to ${tokenPath}`);
  console.log(`Granted models: ${[...grantedModels].join(', ')}`);
});

function commaSeparated(value: string) {
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

function close() {
  server.close(() => store.close());
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
