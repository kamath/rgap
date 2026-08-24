import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { ResourceHandle } from '@rgap/core';
import { resourceId } from '@rgap/core';
import { createApp } from '@rgap/server';
import { SqliteRgapStore } from '@rgap/sqlite';
import { Hono } from 'hono';
import {
  callbackResourceIdForState,
  createMcpClientRuntime,
} from './client';
import { createMockMcpRoutes } from './mock';
import { SqliteSecretStore, type SecretStore } from './store';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 3003);
const publicBaseUrl = process.env.MCP_PROXY_BASE_URL ?? `http://127.0.0.1:${port}`;
const mockServerUrl = `${publicBaseUrl}/mcp`;
const serverUrl = process.env.MCP_SERVER_URL ?? mockServerUrl;
const useMock = process.env.MCP_SERVER_URL === undefined;
const secretStore: SecretStore = new SqliteSecretStore(`${directory}/secrets.db`);
const mcpClient = createMcpClientRuntime({ secretStore, publicBaseUrl });

const store = new SqliteRgapStore({
  url: `${directory}/rgap.db`,
  runtimes: { mcpClient },
});
const admin = store.admin();
await admin.reset();

const credential = await admin.resources.create({
  name: 'mcp/demo/credential',
});
const callback = await admin.resources.create({
  name: 'mcp/demo/callback',
  executable: {
    runtime: 'mcpClient',
    input: { serverUrl, operation: 'callback' },
    bind: { credential: credential.id },
  },
});
const authorize = await admin.resources.create({
  name: 'mcp/demo/authorize',
  executable: {
    runtime: 'mcpClient',
    input: {
      serverUrl,
      operation: 'authorize',
      callbackResourceId: callback.id,
    },
    bind: { credential: credential.id },
  },
});
const rpc = await admin.resources.create({
  name: 'mcp/demo/rpc',
  executable: {
    runtime: 'mcpClient',
    input: { serverUrl, operation: 'rpc' },
    bind: { credential: credential.id },
  },
});

const callbackActor = await admin.grants.create({
  name: 'mcp-proxy/oauth-callback',
  resources: [{ id: callback.id, permissions: ['invoke'] }],
  expiresAt: null,
});
const callbackToken = await callbackActor.tokens.create({ label: 'oauth-callback' });

const consumerGrant = await admin.grants.create({
  name: 'mcp/demo/consumer',
  resources: [
    { id: authorize.id, permissions: ['invoke'] },
    { id: rpc.id, permissions: ['invoke'] },
  ],
  expiresAt: null,
});
const consumerToken = await consumerGrant.tokens.create({ label: 'consumer' });
const tokenPath = `${directory}/consumer.token`;
writeFileSync(tokenPath, consumerToken.value, { mode: 0o600 });

const rgap = createApp({
  store,
  adminToken: process.env.RGAP_ADMIN_TOKEN ?? 'test',
});
const app = new Hono();
app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  if (error) return c.text(`Authorization failed: ${error}`, 400);
  if (!code || !state) return c.text('Missing code or state.', 400);
  const callbackId = await callbackResourceIdForState(secretStore, state);
  if (!callbackId) return c.text('OAuth session is unknown or expired.', 400);
  const handle = await store.as(callbackToken.value).resources.get(resourceId(callbackId));
  await invokeOne(handle, { code, state });
  return c.text('MCP authorization complete. You can close this window.');
});
if (useMock) {
  app.route('/', createMockMcpRoutes({
    issuer: publicBaseUrl,
    mcpPath: '/mcp',
  }));
}
app.route('/', rgap);

const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`MCP proxy listening on http://127.0.0.1:${listeningPort}`);
  console.log(`MCP server: ${serverUrl}`);
  console.log(`Authorize resource: ${authorize.id}`);
  console.log(`RPC resource: ${rpc.id}`);
  console.log(`Bearer token written to ${tokenPath}`);
});

function close() {
  server.close(() => {
    store.close();
    void secretStore.close();
  });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);

async function invokeOne(handle: ResourceHandle, input: unknown) {
  let count = 0;
  for await (const event of handle.invoke({ input })) {
    if (event.type !== 'data') continue;
    count += 1;
  }
  if (count !== 1) throw new Error('Callback invocation did not return one value.');
}
