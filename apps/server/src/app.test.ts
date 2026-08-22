import { hc } from 'hono/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRgapStore } from '@rgap/sqlite';
import { createApp, type AppType } from './app';
import { createClient } from './client/generated/client';
import * as sdk from './client/generated/sdk.gen';

const adminToken = 'test-admin-token';
const authorization = `Bearer ${adminToken}`;
const headers = { authorization };
const expectedOperations = [
  'getResource',
  'listResources',
  'createResource',
  'moveResource',
  'deleteResource',
  'getGrant',
  'listGrants',
  'createGrant',
  'setCapabilities',
  'issueToken',
  'revokeGrant',
  'getToken',
  'listTokens',
  'revokeToken',
  'listAudit',
  'authorize',
  'inspectToken',
  'reset',
] as const;

let store: SqliteRgapStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function testApp() {
  store = new SqliteRgapStore();
  return createApp({ store, adminToken });
}

describe('RGAP Hono API', () => {
  it('publishes one OpenAPI and HeyAPI operation for every RgapCommands method', async () => {
    const app = testApp();
    const response = await app.request('/openapi.json');
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const operationIds = Object.values(document.paths)
      .flatMap((path) => Object.values(path))
      .flatMap((operation) => operation.operationId ?? []);

    expect(response.status).toBe(200);
    expect(operationIds.sort()).toEqual([...expectedOperations].sort());
    expect(expectedOperations.every((operation) => typeof sdk[operation] === 'function')).toBe(true);

    const ui = await app.request('/ui');
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('/openapi.json');
  });

  it('validates input and selects only valid bearer planes', async () => {
    const app = testApp();

    expect((await app.request('/resources')).status).toBe(401);
    expect((await app.request('/resources', {
      headers: { authorization: 'Bearer unknown' },
    })).status).toBe(401);

    const invalid = await app.request('/resources', {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', parentId: null }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('starts without a remote administrative bearer', async () => {
    store = new SqliteRgapStore();
    const app = createApp({ store });

    expect((await app.request('/openapi.json')).status).toBe(200);
    expect((await app.request('/reset', {
      method: 'POST',
      headers: { authorization },
    })).status).toBe(401);
  });

  it('uses RGAP bearers for guarded commands and reserves root commands for the admin bearer', async () => {
    const app = testApp();
    const request = (path: string, body: unknown, bearer = adminToken) => app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const root = await (await request('/resources', { name: 'acme', parentId: null })).json() as { id: string };
    const grant = await (await request('/grants', {
      name: 'writer',
      parentId: null,
      capabilities: [{ resourceId: root.id, permissions: ['write'] }],
      expiresAt: null,
    })).json() as { id: string };
    const issued = await (await request(`/grants/${grant.id}/tokens`, { label: 'guarded' })).json() as {
      value: string;
    };

    expect((await request('/resources', { name: 'docs', parentId: root.id }, issued.value)).status).toBe(200);
    expect((await request('/resources', { name: 'other', parentId: null }, issued.value)).status).toBe(403);
    expect((await request('/grants', {
      name: 'child',
      parentId: grant.id,
      capabilities: [],
      expiresAt: null,
    }, issued.value)).status).toBe(200);
    expect((await request('/grants', {
      name: 'root',
      parentId: null,
      capabilities: [],
      expiresAt: null,
    }, issued.value)).status).toBe(403);
  });

  it('exposes the same route contract through Hono RPC', async () => {
    const app = testApp();
    const client = hc<AppType>('http://rgap.test', {
      headers: { Authorization: authorization },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(input, init)),
    });

    const created = await client.resources.$post({
      json: { name: 'acme', parentId: null },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect('name' in createdBody ? createdBody.name : undefined).toBe('acme');

    const listed = await client.resources.$get({
      query: { parentId: null, limit: 10 },
    });
    const listedBody = await listed.json();
    expect(Array.isArray(listedBody) ? listedBody.map((resource) => resource.name) : [])
      .toEqual(['acme']);
  });

  it('runs every generated HeyAPI command against the application', async () => {
    const app = testApp();
    const client = createClient({
      baseUrl: 'http://rgap.test',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(input, init)),
    });

    const root = await sdk.createResource({
      client,
      headers,
      body: { name: 'acme', parentId: null },
    });
    expect(root.error).toBeUndefined();
    expect(root.data?.name).toBe('acme');

    const child = await sdk.createResource({
      client,
      headers,
      body: { name: 'docs', parentId: root.data!.id },
    });
    const childId = child.data!.id;
    expect((await sdk.getResource({ client, headers, path: { id: childId } })).data?.parentId)
      .toBe(root.data!.id);
    expect((await sdk.listResources({
      client,
      headers,
      query: { parentId: root.data!.id, limit: 10 },
    })).data?.map((resource) => resource.id)).toEqual([childId]);
    expect((await sdk.moveResource({
      client,
      headers,
      path: { id: childId },
      body: { parentId: null },
    })).data?.parentId).toBeNull();

    const grant = await sdk.createGrant({
      client,
      headers,
      body: {
        name: 'Acme admin',
        parentId: null,
        capabilities: [{ resourceId: root.data!.id, permissions: ['read', 'write', 'delete', 'move', 'invoke'] }],
        expiresAt: null,
      },
    });
    const grantId = grant.data!.id;
    expect((await sdk.getGrant({ client, headers, path: { id: grantId } })).data?.name)
      .toBe('Acme admin');
    expect((await sdk.listGrants({ client, headers, query: { parentId: null } })).data?.[0].id)
      .toBe(grantId);
    expect((await sdk.setCapabilities({
      client,
      headers,
      path: { id: grantId },
      body: { capabilities: [{ resourceId: root.data!.id, permissions: ['read'] }] },
    })).data?.capabilities[0]).toMatchObject({ permissions: ['read'] });

    const issued = await sdk.issueToken({
      client,
      headers,
      path: { id: grantId },
      body: { label: 'sdk' },
    });
    const bearer = issued.data!.value;
    const tokenRecord = issued.data!.record;
    expect((await sdk.getToken({ client, headers, path: { id: tokenRecord.id } })).data?.label).toBe('sdk');
    expect((await sdk.listTokens({ client, headers, query: { grantId } })).data?.[0].id)
      .toBe(tokenRecord.id);
    expect((await sdk.inspectToken({ client, headers, body: { token: bearer } })).data?.valid).toBe(true);
    expect((await sdk.authorize({
      client,
      headers,
      body: { token: bearer, resourceId: root.data!.id, permission: 'read' },
    })).data?.allowed).toBe(true);
    expect((await sdk.listAudit({ client, headers })).data?.some((event) => event.action === 'authorize'))
      .toBe(true);

    expect((await sdk.revokeToken({ client, headers, path: { id: tokenRecord.id } })).response?.status)
      .toBe(204);
    expect((await sdk.revokeGrant({ client, headers, path: { id: grantId } })).response?.status)
      .toBe(204);
    expect((await sdk.deleteResource({ client, headers, path: { id: childId } })).response?.status)
      .toBe(204);
    expect((await sdk.reset({ client, headers })).response?.status).toBe(204);
  });
});
