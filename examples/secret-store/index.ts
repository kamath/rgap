import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { InvokeRuntime } from '@rgap/core';
import { createApp } from '@rgap/server';
import { SqliteRgapStore } from '@rgap/sqlite';
import { z } from 'zod';
import {
  SqliteSecretStore,
  type SecretStore,
} from './store';

const directory = fileURLToPath(new URL('.', import.meta.url));
const secretStore: SecretStore = new SqliteSecretStore(`${directory}/secrets.db`);

const revealSecret: InvokeRuntime<null, string> = {
  inputSchema: z.null(),
  outputSchema: z.string(),
  bindings: {
    secret: { kind: 'resource' },
  },
  async invoke({ bindings }) {
    const value = await secretStore.get(bindings.secret.resourceId);
    if (value === undefined) throw new Error('Secret is unavailable.');
    return value;
  },
};

const store = new SqliteRgapStore({
  url: `${directory}/rgap.db`,
  runtimes: { revealSecret },
});

const admin = store.admin();
await admin.reset();

const reveal = await admin.resources.create({
  name: 'services/secret-store/reveal',
});
await reveal.executable.set({ runtime: 'revealSecret' });

const githubToken = await admin.resources.create({
  name: 'users/alice/secrets/github-token',
});
await secretStore.set(
  githubToken.id,
  process.env.DEMO_SECRET ?? 'example-user-secret',
);

const grant = await admin.grants.create({
  name: 'users/alice/secret-reader',
  resources: [
    { id: reveal.id, permissions: ['invoke'] },
    { id: githubToken.id, permissions: ['invoke'] },
  ],
  expiresAt: null,
});
const token = await grant.tokens.create({ label: 'secret-reader' });
const tokenPath = `${directory}/secret-reader.token`;
writeFileSync(tokenPath, token.value, { mode: 0o600 });

const app = createApp({
  store,
  adminToken: process.env.RGAP_ADMIN_TOKEN ?? 'test',
});
const port = Number(process.env.PORT ?? 3002);
const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`Secret-store example listening on http://localhost:${listeningPort}`);
  console.log(`Bearer token written to ${tokenPath}`);
  console.log(`Reveal resource: ${reveal.id}`);
  console.log(`Secret binding: ${githubToken.id}`);
});

function close() {
  server.close(async () => {
    store.close();
    await secretStore.close();
  });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
