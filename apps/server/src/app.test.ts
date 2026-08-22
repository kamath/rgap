import { hc } from 'hono/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resourceId,
  type InvokeRuntime,
  type RuntimeCredentialStore,
  type SecretStore,
} from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';
import { createApp, type AppType } from './app';
import { createClient } from './client/generated/client';
import * as sdk from './client/generated/sdk.gen';
import { HttpRgapStore } from './http-store';

const adminToken = 'test-admin-token';
const authorization = `Bearer ${adminToken}`;
const headers = { authorization };
const expectedOperations = [
  'getResource',
  'listResources',
  'createResource',
  'moveResource',
  'deleteResource',
  'getExecutable',
  'getExecutableRevision',
  'listExecutableRevisions',
  'publishExecutable',
  'deleteExecutable',
  'getSecretMetadata',
  'writeSecret',
  'deleteSecret',
  'getRuntimePrivateMetadata',
  'invoke',
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

function executableTestApp() {
  const versions = new Map<string, number>();
  const secrets: SecretStore = {
    async write(id) {
      const version = (versions.get(id) ?? 0) + 1;
      versions.set(id, version);
      return { resourceId: id, version: String(version), updatedAt: new Date().toISOString() };
    },
    async delete(id) {
      versions.delete(id);
    },
    async handle(id) {
      return { resourceId: id, kind: 'secret' };
    },
    async resolve() {
      return 'protected';
    },
  };
  const credentials = new Map<string, number>();
  const credentialStore: RuntimeCredentialStore = {
    async metadata(runtime, id) {
      const version = credentials.get(`${runtime}:${id}`);
      return version === undefined ? undefined : {
        runtime, resourceId: id, version: String(version), updatedAt: new Date().toISOString(),
      };
    },
    async handle(runtime, id) {
      return credentials.has(`${runtime}:${id}`)
        ? { runtime, resourceId: id, kind: 'runtime-credential' }
        : undefined;
    },
    async write(runtime, id) {
      const key = `${runtime}:${id}`;
      const version = (credentials.get(key) ?? 0) + 1;
      credentials.set(key, version);
      return { runtime, resourceId: id, version: String(version), updatedAt: new Date().toISOString() };
    },
    async delete(runtime, id) {
      credentials.delete(`${runtime}:${id}`);
    },
  };
  const runtime: InvokeRuntime = {
    validate() {},
    async *invoke(context) {
      if (context.bindings.credential) await context.credentials.write('credential', { refreshed: true });
      yield { type: 'data', value: context.input };
      yield { type: 'done' };
    },
  };
  store = new SqliteRgapStore({
    runtimes: { test: runtime },
    validator: { validate: () => ({ valid: true }) },
    secrets,
    credentials: credentialStore,
  });
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

  it('defaults the server and HTTP store administrative bearer to test', async () => {
    store = new SqliteRgapStore();
    const app = createApp({ store });
    const remote = new HttpRgapStore({
      baseUrl: 'http://rgap.test',
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });

    expect((await app.request('/openapi.json')).status).toBe(200);
    expect((await app.request('/reset', {
      method: 'POST',
      headers: { authorization: 'Bearer test' },
    })).status).toBe(204);
    await remote.admin().reset();
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

  it('serves executable, secret metadata, runtime metadata, and NDJSON invocation commands', async () => {
    const app = executableTestApp();
    const request = (path: string, method: string, body?: unknown, bearer = adminToken) => app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const executable = await (await request('/resources', 'POST', {
      name: 'echo',
      parentId: null,
    })).json() as { id: string };
    const credential = await (await request('/resources', 'POST', {
      name: 'credential',
      parentId: null,
    })).json() as { id: string };
    const publication = {
      runtime: 'test',
      program: { operation: 'echo' },
      inputSchema: true,
      outputSchema: true,
      bindingSchema: {
        credential: { kind: 'runtime-private', access: 'write' },
      },
      limits: { timeoutMs: 1000 },
    };

    const published = await request(
      `/resources/${executable.id}/executable/revisions`,
      'POST',
      publication,
    );
    const revision = await published.json() as { id: string; resourceId: string };
    expect(published.status).toBe(200);
    expect(revision.resourceId).toBe(executable.id);
    expect(await (await request(`/resources/${executable.id}/executable`, 'GET')).json())
      .toMatchObject({ resourceId: executable.id, activeRevisionId: revision.id });
    expect(await (await request(`/executable-revisions/${revision.id}`, 'GET')).json())
      .toMatchObject({ id: revision.id, program: publication.program });
    expect(await (await request(`/resources/${executable.id}/executable/revisions`, 'GET')).json())
      .toHaveLength(1);

    const secretWriterGrant = await (await request('/grants', 'POST', {
      name: 'secret writer',
      parentId: null,
      capabilities: [{ resourceId: credential.id, permissions: ['write'] }],
      expiresAt: null,
    })).json() as { id: string };
    const secretWriter = await (await request(`/grants/${secretWriterGrant.id}/tokens`, 'POST', {
      label: 'secret writer',
    })).json() as { value: string };
    const secretValue = 'must-never-be-returned';
    const secretResponse = await request(`/resources/${credential.id}/secret`, 'PUT', {
      value: secretValue,
    }, secretWriter.value);
    const secretMetadata = await secretResponse.json() as Record<string, unknown>;
    expect(secretResponse.status).toBe(200);
    expect(secretMetadata).toEqual({
      resourceId: credential.id,
      version: '1',
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(secretMetadata)).not.toContain(secretValue);
    expect((await request(
      `/resources/${credential.id}/secret`,
      'GET',
      undefined,
      secretWriter.value,
    )).status).toBe(403);
    expect(await (await request(`/resources/${credential.id}/secret`, 'GET')).json())
      .toEqual(secretMetadata);

    expect((await request(`/resources/${executable.id}/invoke`, 'POST', {
      input: {},
      bindings: { credential: credential.id },
      signal: {},
    })).status).toBe(400);
    const invoked = await request(`/resources/${executable.id}/invoke`, 'POST', {
      input: { message: 'hello' },
      bindings: { credential: credential.id },
      revisionId: revision.id,
    });
    expect(invoked.status).toBe(200);
    expect(invoked.headers.get('content-type')).toContain('application/x-ndjson');
    expect((await invoked.text()).trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { type: 'data', value: { message: 'hello' } },
      { type: 'done' },
    ]);
    expect(await (await request(
      `/resources/${credential.id}/runtime-private/test`,
      'GET',
    )).json()).toMatchObject({
      runtime: 'test',
      resourceId: credential.id,
      version: '1',
    });

    const readerGrant = await (await request('/grants', 'POST', {
      name: 'reader',
      parentId: null,
      capabilities: [{ resourceId: executable.id, permissions: ['read'] }],
      expiresAt: null,
    })).json() as { id: string };
    const reader = await (await request(`/grants/${readerGrant.id}/tokens`, 'POST', {
      label: 'reader',
    })).json() as { value: string };
    expect((await request(`/resources/${executable.id}/executable`, 'GET', undefined, reader.value)).status)
      .toBe(200);
    expect((await request(
      `/resources/${executable.id}/executable/revisions`,
      'POST',
      publication,
      reader.value,
    )).status).toBe(403);
    expect((await request(
      `/resources/${executable.id}/invoke`,
      'POST',
      { input: {}, bindings: { credential: credential.id } },
      reader.value,
    )).status).toBe(403);

    expect((await request(`/resources/${credential.id}/secret`, 'DELETE')).status).toBe(204);
    expect((await request(`/resources/${executable.id}/executable`, 'DELETE')).status).toBe(204);
    expect((await request(`/resources/${executable.id}/executable`, 'GET')).status).toBe(200);
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

  it('iterates NDJSON invocation events through HttpRgapStore', async () => {
    const app = executableTestApp();
    const remote = new HttpRgapStore({
      baseUrl: 'http://rgap.test',
      adminToken,
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const admin = remote.admin();
    const executable = await admin.resources.create({ name: 'remote-echo' });
    const secret = await admin.resources.create({ name: 'remote-secret' });
    const revision = await executable.executable.publish({
      runtime: 'test',
      program: { operation: 'echo' },
      inputSchema: true,
      outputSchema: true,
      bindingSchema: {},
      limits: {},
    });

    expect((await executable.executable.get())?.activeRevisionId).toBe(revision.id);
    expect((await executable.executable.revisions()).map(({ id }) => id)).toEqual([revision.id]);
    expect(await secret.secret.write('remote-value')).toMatchObject({
      resourceId: secret.id,
      version: '1',
    });
    expect(await secret.secret.metadata()).toMatchObject({ resourceId: secret.id });
    const events = [];
    for await (const event of executable.invoke({ input: { remote: true }, revisionId: revision.id })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'data', value: { remote: true } },
      { type: 'done' },
    ]);
    await secret.secret.delete();
    await executable.executable.delete();
  });

  it('presents the HTTP API through the RgapStore interface', async () => {
    const app = testApp();
    const remote = new HttpRgapStore({
      baseUrl: 'http://rgap.test',
      adminToken,
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const admin = remote.admin();

    await admin.reset();
    const root = await admin.resources.create({ name: 'acme' });
    const grant = await admin.grants.create({
      name: 'writer',
      capabilities: [{ resourceId: root.id, permissions: ['read', 'write'] }],
      expiresAt: null,
    });
    const issued = await grant.tokens.create({ label: 'remote' });
    const guarded = remote.as(issued.value);
    const child = await (await guarded.resources.get(root.id)).create({ name: 'docs' });
    const delegated = await guarded.grants.create({
      name: 'reader',
      capabilities: [{ resourceId: root.id, permissions: ['read'] }],
      expiresAt: null,
    });

    expect(child.parentId).toBe(root.id);
    expect(delegated.parentId).toBe(grant.id);
    expect((await guarded.resources.list()).map((resource) => resource.id))
      .toEqual([root.id, child.id]);
    expect((await guarded.inspectToken(issued.value)).valid).toBe(true);
    await expect(admin.resources.get(resourceId('missing'))).rejects.toMatchObject({
      code: 'missing_resource',
    });
    await expect(guarded.resources.get(resourceId('missing'))).rejects.toMatchObject({
      code: 'unauthorized',
    });
    remote.close();
  });
});
