import type {
  RgapRepository,
  RgapStore,
} from '@rgap/core';
import type { CredentialStore } from '@rgap/local-credential-store';
import type {
  OAuthFlowRecord,
  OAuthFlowStore,
} from '@rgap/local-oauth-flow-store';
import { ProtocolError } from '@modelcontextprotocol/client';
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
        serverInfo: { name: 'rgap-mcp-proxy', version: '0.0.0' },
      },
    });
    expect(initialized.headers.has('mcp-session-id')).toBe(false);

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

  it('requires JSON bearers and accepts only initialized notifications', async () => {
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

    const wrongType = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

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

    const unsupported = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
      }),
    });
    expect(unsupported.status).toBe(400);

    const stream = await app.request('/mcp/connection_1');
    expect(stream.status).toBe(405);
    expect(stream.headers.get('allow')).toBe('POST');
  });

  it('rejects disallowed origins, versions, and server discovery locally', async () => {
    const calls: unknown[] = [];
    const app = createMcpProxyApp({
      mcp: runtime('https://example.com/gateway'),
      store: fakeRgapStore(calls),
    });
    const headers = {
      authorization: 'Bearer token',
      'content-type': 'application/json',
    };
    const origin = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers: { ...headers, origin: 'https://attacker.example' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });
    expect(origin.status).toBe(403);

    const version = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05' },
      }),
    });
    expect(version.status).toBe(400);

    const discover = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'server/discover',
      }),
    });
    expect(discover.status).toBe(200);
    expect(await discover.json()).toMatchObject({
      id: 3,
      error: { code: -32601 },
    });
    expect(calls).toEqual([]);
  });

  it('preserves upstream MCP protocol errors', async () => {
    const app = createMcpProxyApp({
      mcp: runtime('https://example.com'),
      store: fakeRgapStore([]),
    });
    const response = await app.request('/mcp/connection_1', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/fail',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: {
        code: -32602,
        message: 'Invalid tool arguments.',
        data: { tool: 'fail' },
      },
    });
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
      if (method === 'tools/fail') {
        return (async function* () {
          throw new ProtocolError(
            -32602,
            'Invalid tool arguments.',
            { tool: 'fail' },
          );
        })();
      }
      const value = method === 'initialize'
        ? {
            capabilities: {
              tools: { listChanged: true },
              logging: {},
            },
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
