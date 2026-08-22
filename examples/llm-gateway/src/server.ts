import { serve } from '@hono/node-server';
import { resourceId } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';
import { createLlmGateway } from './app';
import { databaseUrl, requiredEnvironment, serverPort } from './config';

const store = new SqliteRgapStore({ url: databaseUrl() });
const port = serverPort();
const app = createLlmGateway({
  store,
  openAiResourceId: resourceId(requiredEnvironment('OPENAI_RESOURCE_ID')),
  openAiApiKey: requiredEnvironment('OPENAI_API_KEY'),
  upstreamOrigin: process.env.OPENAI_UPSTREAM_ORIGIN,
});
const server = serve({ fetch: app.fetch, port });

console.log(`OpenAI-compatible RGAP gateway listening on http://localhost:${port}/v1`);

const close = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
