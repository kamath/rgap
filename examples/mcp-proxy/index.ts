import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  type ResourceHandle,
  type ResourceId,
  type RgapRepository,
  type SetExecutableInput,
} from '@rgap/core';
import { PostgresCredentialStore } from '@rgap/credential-store-postgres';
import { SqliteCredentialStore } from '@rgap/credential-store-sqlite';
import {
  createMcpProxyApp,
  createMcpProxyRuntime,
  type McpCredential,
} from '@rgap/mcp-proxy';
import { PostgresOAuthFlowStore } from '@rgap/oauth-flow-store-postgres';
import { SqliteOAuthFlowStore } from '@rgap/oauth-flow-store-sqlite';
import { createApp as createRgapApp } from '@rgap/server';
import { PostgresRgapStore } from '@rgap/store-postgres';
import { SqliteRgapStore } from '@rgap/store-sqlite';
import { Hono } from 'hono';

const directory = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 3003);
const publicBaseUrl = new URL(
  process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
);
const serverUrl = new URL(
  process.env.MCP_SERVER_URL ?? 'https://server.smithery.ai/gmail',
);
const postgresUrl = process.env.RGAP_POSTGRES_URL;
const credentialStore = postgresUrl
  ? new PostgresCredentialStore<McpCredential>({ url: postgresUrl })
  : new SqliteCredentialStore<McpCredential>({
      url: `${directory}/credentials.db`,
    });
const flowStore = postgresUrl
  ? new PostgresOAuthFlowStore({ url: postgresUrl })
  : new SqliteOAuthFlowStore({ url: `${directory}/oauth-flows.db` });
if (
  credentialStore instanceof PostgresCredentialStore
  && flowStore instanceof PostgresOAuthFlowStore
) {
  await Promise.all([
    credentialStore.migrate(),
    flowStore.migrate(),
  ]);
}
const mcp = createMcpProxyRuntime({
  publicBaseUrl,
  credentialStore,
  flowStore,
});

const store = postgresUrl
  ? new PostgresRgapStore({
      url: postgresUrl,
      runtimes: { mcp: mcp.runtime },
    })
  : new SqliteRgapStore({
      url: `${directory}/rgap.db`,
      runtimes: { mcp: mcp.runtime },
    });
if (store instanceof PostgresRgapStore) await store.migrate();
const admin = store.admin();
const serverName = resourceName(serverUrl);
const serverResource = await ensureResource(admin, `acme/mcp/servers/${serverName}`);
const credential = await ensureResource(
  admin,
  `acme/mcp/credentials/${serverName}-default`,
);
if (!await credentialStore.get(credential.id)) {
  await credentialStore.set(credential.id, {});
}
const connectionResource = await ensureExecutableResource(
  admin,
  `acme/mcp/connections/${serverName}-default`,
  {
    runtime: 'mcp',
    input: { serverUrl: serverUrl.toString() },
    bind: {
      server: serverResource.id,
      credential: credential.id,
    },
  },
);

const invoker = await admin.grants.create({
  name: `examples/mcp-proxy/invoker-${randomUUID()}`,
  bindings: [{ id: connectionResource.id, permissions: ['invoke'] }],
  expiresAt: null,
});
const invokerToken = await invoker.tokens.create({ label: 'mcp-proxy-example' });
const tokenPath = `${directory}/invoker.token`;
writeFileSync(tokenPath, invokerToken.value, { mode: 0o600 });

const initialStatus = await mcp.connect(serverUrl, credential.id).catch((error: unknown) => {
  console.error(`Initial MCP connection failed: ${message(error)}`);
  return undefined;
});

const app = new Hono();
app.route('/', createMcpProxyApp({ mcp, store }));
app.route('/rgap', createRgapApp({
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

async function ensureExecutableResource(
  repository: RgapRepository,
  path: string,
  executable: SetExecutableInput,
) {
  const segments = path.split('/');
  const name = segments.pop();
  if (!name || !segments.length) {
    throw new Error('Executable resources require a parent folder.');
  }
  const parent = await ensureResource(repository, segments.join('/'));
  const existing = await child(repository, parent.id, name);
  if (existing) {
    if (!existing.executable) {
      throw new Error(`Resource ${path} exists as a folder.`);
    }
    return existing;
  }
  return parent.create({ name, executable });
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
  const label = `${url.protocol.slice(0, -1)}-${url.host}${path ? `-${path}` : ''}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-');
  const digest = createHash('sha256').update(url.toString()).digest('hex').slice(0, 8);
  return `${label}-${digest}`;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function close() {
  server.close(async () => {
    await mcp.close();
    await store.close();
    await credentialStore.close();
    await flowStore.close();
  });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
