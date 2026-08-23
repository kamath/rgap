import {
  grantId,
  repositoryFrom,
  resourceId,
  RgapError,
  tokenHash,
  tokenId,
  tokenValue,
  type AuditEvent,
  type GrantResource,
  type ExecutableDefinition,
  type InvocationEvent,
  type Grant,
  type Permission,
  type RecordId,
  type Resource,
  type RgapCommands,
  type RgapRepository,
  type RgapStore,
  type Token,
  type TokenValue,
} from '@rgap/core';
import {
  authorize,
  createGrant,
  createResource,
  deleteExecutable,
  deleteResource,
  getExecutable,
  getGrant,
  getResource,
  getToken,
  inspectToken,
  issueToken,
  listAudit,
  listGrants,
  listResources,
  listTokens,
  moveResource,
  setExecutable,
  reset,
  revokeGrant,
  revokeToken,
  setResources,
} from './client/generated/sdk.gen';
import { createClient, type Client } from './client/generated/client';
import type {
  ApiError,
  AuditEvent as HttpAuditEvent,
  GrantResource as HttpGrantResource,
  ExecutableDefinition as HttpExecutableDefinition,
  Grant as HttpGrant,
  Resource as HttpResource,
  Token as HttpToken,
} from './client/generated/types.gen';

export type HttpRgapStoreOptions = {
  baseUrl: string;
  adminToken?: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * An RgapStore whose command sink is the generated HTTP SDK.
 *
 * The adapter is stateless, so close() exists only to let callers switch it with a local store.
 */
export class HttpRgapStore implements RgapStore {
  private readonly client: Client;

  constructor(private readonly options: HttpRgapStoreOptions) {
    this.client = createClient({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    });
  }

  admin(): RgapRepository {
    return repositoryFrom(new HttpRgapCommands(
      this.client,
      tokenValue(this.options.adminToken ?? 'test'),
      true,
      this.options,
    ));
  }

  as(token: TokenValue): RgapRepository {
    return repositoryFrom(new HttpRgapCommands(this.client, token, false, this.options));
  }

  close() {}
}

class HttpRgapCommands implements RgapCommands {
  constructor(
    private readonly client: Client,
    private readonly bearer: TokenValue,
    private readonly admin: boolean,
    private readonly storeOptions: HttpRgapStoreOptions,
  ) {}

  async getResource(id: ReturnType<typeof resourceId>) {
    const result = await getResource(this.options({ path: { id } }));
    return result.response?.status === 404 ? undefined : asResource(unwrap(result));
  }

  async listResources(query = {}) {
    const result = await listResources(this.options({ query }));
    return unwrap(result).map(asResource);
  }

  async getGrant(id: ReturnType<typeof grantId>) {
    const result = await getGrant(this.options({ path: { id } }));
    return result.response?.status === 404 ? undefined : asGrant(unwrap(result));
  }

  async listGrants(query = {}) {
    const result = await listGrants(this.options({ query }));
    return unwrap(result).map(asGrant);
  }

  async getToken(id: ReturnType<typeof tokenId>) {
    const result = await getToken(this.options({ path: { id } }));
    return result.response?.status === 404 ? undefined : asToken(unwrap(result));
  }

  async listTokens(query = {}) {
    const result = await listTokens(this.options({ query }));
    return unwrap(result).map(asToken);
  }

  async listAudit(query = {}) {
    const result = await listAudit(this.options({ query }));
    return unwrap(result).map(asAuditEvent);
  }

  async createResource(input: Parameters<RgapCommands['createResource']>[0]) {
    return asResource(unwrap(await createResource(this.options({ body: input }))));
  }

  async moveResource(id: ReturnType<typeof resourceId>, parentId: ReturnType<typeof resourceId> | null) {
    return asResource(unwrap(await moveResource(this.options({
      path: { id },
      body: { parentId },
    }))));
  }

  async deleteResource(id: ReturnType<typeof resourceId>) {
    unwrap<void>(await deleteResource(this.options({ path: { id } })));
  }

  async getExecutable(id: ReturnType<typeof resourceId>) {
    const result = await getExecutable(this.options({ path: { id } }));
    return result.response?.status === 404 ? undefined : asExecutableDefinition(unwrap(result));
  }

  async setExecutable(
    id: ReturnType<typeof resourceId>,
    input: Parameters<RgapCommands['setExecutable']>[1],
  ) {
    return asExecutableDefinition(unwrap(await setExecutable(this.options({
      path: { id },
      body: input,
    }))));
  }

  async deleteExecutable(id: ReturnType<typeof resourceId>) {
    unwrap<void>(await deleteExecutable(this.options({ path: { id } })));
  }

  invoke(id: ReturnType<typeof resourceId>, input: Parameters<RgapCommands['invoke']>[1]) {
    const commands = this;
    return (async function* (): AsyncIterable<InvocationEvent> {
      const response = await (commands.storeOptions.fetch ?? globalThis.fetch)(
        new URL(
          `${commands.storeOptions.baseUrl.replace(/\/$/, '')}/resources/${encodeURIComponent(id)}/invoke`,
        ),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${commands.bearer}`,
            'content-type': 'application/json',
            accept: 'application/x-ndjson',
          },
          body: JSON.stringify({
            input: input.input,
            bindings: input.bindings,
          }),
          signal: input.signal,
        },
      );
      if (!response.ok) throw await responseError(response);
      if (!response.body) throw new RgapError('http_error', 'RGAP invocation response has no body.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffered += decoder.decode(value, { stream: !done });
          let newline = buffered.indexOf('\n');
          while (newline >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (line.trim()) yield asInvocationEvent(JSON.parse(line));
            newline = buffered.indexOf('\n');
          }
          if (done) break;
        }
        if (buffered.trim()) yield asInvocationEvent(JSON.parse(buffered));
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    })();
  }

  async createGrant(input: Parameters<RgapCommands['createGrant']>[0]) {
    const parentId = input.parentId === null && !this.admin
      ? await this.actingGrantId()
      : input.parentId;
    return asGrant(unwrap(await createGrant(this.options({
      body: { ...input, parentId, resources: input.resources.map(asHttpGrantResource) },
    }))));
  }

  async setResources(id: ReturnType<typeof grantId>, resources: GrantResource[]) {
    return asGrant(unwrap(await setResources(this.options({
      path: { id },
      body: { resources: resources.map(asHttpGrantResource) },
    }))));
  }

  async issueToken(id: ReturnType<typeof grantId>, label: string) {
    const issued = unwrap(await issueToken(this.options({
      path: { id },
      body: { label },
    })));
    return { record: asToken(issued.record), value: tokenValue(issued.value) };
  }

  async revokeToken(id: ReturnType<typeof tokenId>) {
    unwrap<void>(await revokeToken(this.options({ path: { id } })));
  }

  async revokeGrant(id: ReturnType<typeof grantId>) {
    unwrap<void>(await revokeGrant(this.options({ path: { id } })));
  }

  async authorize(token: TokenValue, id: ReturnType<typeof resourceId>, permission: Permission) {
    const decision = unwrap(await authorize(this.options({
      body: { token, resourceId: id, permission },
    })));
    return {
      ...decision,
      grantId: decision.grantId === null ? null : grantId(decision.grantId),
      lineage: decision.lineage.map(grantId),
    };
  }

  async inspectToken(token: TokenValue) {
    const view = unwrap(await inspectToken(this.options({ body: { token } })));
    return {
      ...view,
      grantId: view.grantId === null ? null : grantId(view.grantId),
      lineage: view.lineage.map(grantId),
    };
  }

  async reset() {
    unwrap<void>(await reset(this.options({})));
  }

  private options<T extends object>(input: T): T & {
    client: Client;
    headers: { authorization: string };
  } {
    return {
      ...input,
      client: this.client,
      headers: { authorization: `Bearer ${this.bearer}` },
    };
  }

  private async actingGrantId() {
    const view = unwrap(await inspectToken(this.options({ body: { token: this.bearer } })));
    if (!view.valid || view.grantId === null) {
      throw new RgapError('unauthorized', view.detail);
    }
    return grantId(view.grantId);
  }
}

type RequestResult<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

function unwrap<T>(result: RequestResult<T>): T {
  if (result.response?.ok) return result.data as T;
  if (isApiError(result.error)) {
    throw new RgapError(result.error.error.code, result.error.error.message);
  }
  throw new RgapError(
    'http_error',
    `RGAP API request failed${result.response ? ` with status ${result.response.status}` : ''}.`,
  );
}

function isApiError(value: unknown): value is ApiError {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = value.error;
  return Boolean(error && typeof error === 'object' && 'code' in error && 'message' in error);
}

async function responseError(response: Response) {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return new RgapError('http_error', `RGAP API request failed with status ${response.status}.`);
  }
  return isApiError(value)
    ? new RgapError(value.error.code, value.error.message)
    : new RgapError('http_error', `RGAP API request failed with status ${response.status}.`);
}

function asResource(record: HttpResource): Resource {
  return {
    ...record,
    id: resourceId(record.id),
    parentId: record.parentId === null ? null : resourceId(record.parentId),
  };
}

function asExecutableDefinition(record: HttpExecutableDefinition): ExecutableDefinition {
  return {
    ...record,
    resourceId: resourceId(record.resourceId),
  };
}

function asInvocationEvent(value: unknown): InvocationEvent {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new RgapError('invalid_response', 'RGAP invocation returned an invalid event.');
  }
  if (value.type === 'done') return { type: 'done' };
  if (value.type === 'data' && 'value' in value) return { type: 'data', value: value.value };
  throw new RgapError('invalid_response', 'RGAP invocation returned an invalid event.');
}

function asGrant(record: HttpGrant): Grant {
  return {
    ...record,
    id: grantId(record.id),
    parentId: record.parentId === null ? null : grantId(record.parentId),
    resources: record.resources.map(asGrantResource),
  };
}

function asGrantResource(entry: HttpGrantResource): GrantResource {
  return 'id' in entry
    ? { ...entry, id: resourceId(entry.id) }
    : entry;
}

function asHttpGrantResource(entry: GrantResource): HttpGrantResource {
  return entry;
}

function asToken(record: HttpToken): Token {
  return {
    ...record,
    id: tokenId(record.id),
    grantId: grantId(record.grantId),
    hash: tokenHash(record.hash),
  };
}

function asAuditEvent(event: HttpAuditEvent): AuditEvent {
  return { ...event, target: event.target as RecordId };
}
