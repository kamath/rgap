import type {
  RgapRepository,
  RgapStore,
} from '@rgap/core';
import type { CredentialStore } from '@rgap/local-credential-store';
import type {
  OAuthFlowRecord,
  OAuthFlowStore,
} from '@rgap/local-oauth-flow-store';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createMcpProxyApp } from './app';
import type { McpCredential } from './oauth-provider';
import { createMcpProxyRuntime } from './runtime';

describe('createMcpProxyApp', () => {
  it('initializes locally and forwards requests through the guarded repository', async () => {
    const calls: unknown[] = [];
    const store = fakeRgapStore(calls);
    const mcp = runtime('https://example.com/integrations/gmail');
    const app = new Hono();
    app.route('/integrations/gmail', createMcpProxyApp({ mcp, store }));

    const initialized = await app.request(
      '/integrations/gmail/mcp/connection_1',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer rgap-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      },
    );
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'upstream', version: '1.0.0' },
      },
    });

    const listed = await app.request(
      '/integrations/gmail/mcp/connection_1',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer rgap-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'list',
          method: 'tools/list',
          params: {},
        }),
      },
    );
    expect(await listed.json()).toEqual({
      jsonrpc: '2.0',
      id: 'list',
      result: { tools: [{ name: 'search' }] },
    });
    expect(calls).toEqual([
      {
        token: 'rgap-token',
        resourceId: 'connection_1',
        input: { method: 'initialize', params: expect.any(Object) },
      },
      {
        token: 'rgap-token',
        resourceId: 'connection_1',
        input: { method: 'tools/list', params: {} },
      },
    ]);
  });

  it('requires a bearer and accepts initialized notifications without SSE', async () => {
    const mcp = runtime('http://127.0.0.1:3003');
    const app = createMcpProxyApp({ mcp, store: fakeRgapStore([]) });
    const missing = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });
    expect(missing.status).toBe(401);

    const notification = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(notification.status).toBe(202);

    const stream = await app.request('/mcp/connection_1');
    expect(stream.status).toBe(405);
    expect(stream.headers.get('allow')).toBe('POST');
  });

  it('publishes path-prefixed client metadata only over HTTPS', async () => {
    const https = createMcpProxyApp({
      mcp: runtime('https://example.com/integrations/gmail'),
      store: fakeRgapStore([]),
    });
    const metadata = await https.request('/oauth/client-metadata.json');
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      client_id: 'https://example.com/integrations/gmail/oauth/client-metadata.json',
      redirect_uris: [
        'https://example.com/integrations/gmail/oauth/callback',
      ],
    });

    const http = createMcpProxyApp({
      mcp: runtime('http://127.0.0.1:3003'),
      store: fakeRgapStore([]),
    });
    expect((await http.request('/oauth/client-metadata.json')).status).toBe(404);
  });
});

function runtime(publicBaseUrl: string) {
  return createMcpProxyRuntime({
    publicBaseUrl: new URL(publicBaseUrl),
    credentialStore: memoryCredentialStore(),
    flowStore: memoryFlowStore(),
  });
}

function fakeRgapStore(calls: unknown[]): RgapStore {
  let token = '';
  const repository = {
    invoke(resourceId: string, { input }: { input: unknown }) {
      calls.push({ token, resourceId, input });
      const method = (input as { method: string }).method;
      const value = method === 'initialize'
        ? {
            capabilities: { tools: {} },
            serverInfo: { name: 'upstream', version: '1.0.0' },
          }
        : { tools: [{ name: 'search' }] };
      return (async function* () {
        yield { type: 'data' as const, value };
        yield { type: 'done' as const };
      })();
    },
  } as unknown as RgapRepository;
  return {
    as(value) {
      token = value;
      return repository;
    },
    admin: () => repository,
  };
}

function memoryCredentialStore(): CredentialStore<McpCredential> {
  const records = new Map<string, McpCredential>();
  return {
    get: (id) => records.get(id),
    set: (id, value) => {
      records.set(id, value);
    },
    update: (id, update) => {
      const value = update(records.get(id));
      records.set(id, value);
      return value;
    },
    delete: (id) => {
      records.delete(id);
    },
    close: () => undefined,
  };
}

function memoryFlowStore(): OAuthFlowStore {
  const records = new Map<string, OAuthFlowRecord>();
  return {
    async register(state, flow) {
      records.set(state, flow);
    },
    async claim(state) {
      const flow = records.get(state);
      if (!flow) throw new Error('missing');
      return flow;
    },
    async complete(state) {
      records.delete(state);
    },
    async close() {},
  };
}
