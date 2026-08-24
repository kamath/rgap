import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  type InvokeRuntime,
  type ResourceHandle,
  type ResourceId,
  type RgapRepository,
} from '@rgap/core';
import { createApp as createRgapApp } from '@rgap/server';
import { SqliteRgapStore } from '@rgap/sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { SqliteCredentialStore } from './credential-store';
import {
  McpConnection,
  McpInvokeInputSchema,
} from './mcp-connection';
import type { McpCredential } from './oauth-provider';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 3003);
const publicBaseUrl = new URL(process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`);
const serverUrl = new URL(process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:3001/mcp');
const credentialStore = new SqliteCredentialStore<McpCredential>(
  `${directory}/credentials.db`,
);
const connections = new Map<string, McpConnection>();
const flows = new Map<string, McpConnection>();

const McpRuntimeInputSchema = McpInvokeInputSchema.extend({
  serverUrl: z.url(),
  credential: z.string(),
});

const mcpRuntime: InvokeRuntime<
  z.infer<typeof McpRuntimeInputSchema>,
  unknown
> = {
  inputSchema: McpRuntimeInputSchema,
  outputSchema: null,
  async invoke({ input, signal }) {
    const connection = connectionFor(
      new URL(input.serverUrl),
      input.credential,
    );
    if (!connection.isConnected()) {
      const status = await connection.connect();
      registerFlow(connection, status);
      if (status.status === 'authorization_required') {
        throw new Error(`MCP OAuth authorization is required: ${status.authorizationUrl}`);
      }
    }
    return connection.request({
      method: input.method,
      params: input.params,
    }, signal);
  },
};

const store = new SqliteRgapStore({
  url: `${directory}/rgap.db`,
  runtimes: { mcp: mcpRuntime },
});
const admin = store.admin();
const serverName = resourceName(serverUrl);
const serverResource = await ensureResource(admin, `acme/mcp/servers/${serverName}`);
const credential = await ensureResource(
  admin,
  `acme/mcp/credentials/${serverName}-default`,
);
if (!credentialStore.get(credential.id)) credentialStore.set(credential.id, {});
const connectionResource = await ensureResource(
  admin,
  `acme/mcp/connections/${serverName}-default`,
);
await connectionResource.executable.set({
  runtime: 'mcp',
  input: { serverUrl: serverUrl.toString() },
  bind: { credential: credential.id },
});

const invoker = await admin.grants.create({
  name: `examples/mcp-proxy/invoker-${randomUUID()}`,
  resources: [{ id: connectionResource.id, permissions: ['invoke'] }],
  expiresAt: null,
});
const invokerToken = await invoker.tokens.create({ label: 'mcp-proxy-example' });
const tokenPath = `${directory}/invoker.token`;
writeFileSync(tokenPath, invokerToken.value, { mode: 0o600 });

const connection = connectionFor(serverUrl, credential.id);
const initialStatus = await connection.connect().catch((error: unknown) => {
  console.error(`Initial MCP connection failed: ${message(error)}`);
  return undefined;
});
if (initialStatus) registerFlow(connection, initialStatus);

const app = new Hono();
app.get('/oauth/callback/:flowId', async (context) => {
  const flowId = context.req.param('flowId');
  const connection = flows.get(flowId);
  if (!connection) return context.text('OAuth flow not found or expired.', 404);
  try {
    const status = await connection.finishAuthorization(flowId, new URL(context.req.url));
    flows.delete(flowId);
    registerFlow(connection, status);
    if (status.status !== 'connected') {
      return context.text('OAuth authorization did not complete.', 409);
    }
    return context.html('<h1>MCP authorization complete</h1><p>You may close this window.</p>');
  } catch (error) {
    console.error(`OAuth callback failed: ${message(error)}`);
    return context.text('OAuth callback validation failed.', 400);
  }
});
app.route('/', createRgapApp({
  store,
  adminToken: process.env.RGAP_ADMIN_TOKEN ?? 'test',
}));

const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`MCP proxy listening on http://localhost:${listeningPort}`);
  console.log(`Upstream MCP server resource: ${serverResource.id}`);
  console.log(`Executable MCP connection: ${connectionResource.id}`);
  console.log(`RGAP bearer written to ${tokenPath}`);
  if (initialStatus?.status === 'authorization_required') {
    console.log(`Authorize the MCP connection: ${initialStatus.authorizationUrl}`);
  }
});

function connectionFor(upstream: URL, credentialId: string) {
  const existing = connections.get(credentialId);
  if (existing) return existing;
  const connection = new McpConnection({
    serverUrl: upstream,
    credentialId,
    publicBaseUrl,
    credentialStore,
  });
  connections.set(credentialId, connection);
  return connection;
}

function registerFlow(
  connection: McpConnection,
  status: Awaited<ReturnType<McpConnection['connect']>>,
) {
  if (status.status === 'authorization_required') {
    flows.set(status.flowId, connection);
  }
}

async function ensureResource(repository: RgapRepository, path: string) {
  let parent: ResourceHandle | undefined;
  for (const name of path.split('/')) {
    const existing = await child(repository, parent?.id ?? null, name);
    parent = existing ?? (parent
      ? await parent.create({ name })
      : await repository.resources.create({ name }));
  }
  return parent!;
}

async function child(
  repository: RgapRepository,
  parentId: ResourceId | null,
  name: string,
) {
  let cursor: ResourceId | undefined;
  do {
    const page = await repository.resources.list({ parentId, cursor, limit: 100 });
    const match = page.find((resource) => resource.name === name);
    if (match) return repository.resources.get(match.id);
    cursor = page.length === 100 ? page.at(-1)?.id : undefined;
  } while (cursor);
  return undefined;
}

function resourceName(url: URL) {
  const path = url.pathname.split('/').filter(Boolean).join('-');
  return `${url.hostname}${path ? `-${path}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-');
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function close() {
  server.close(async () => {
    await Promise.all([...connections.values()].map((connection) => connection.close()));
    store.close();
    credentialStore.close();
  });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
