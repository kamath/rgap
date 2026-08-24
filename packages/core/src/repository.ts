import {
  isLive,
  RgapError,
  type AuditEvent,
  type GrantBinding,
  type Decision,
  type ExecutableDefinition,
  type Grant,
  type GrantId,
  type Permission,
  type Resource,
  type ResourceId,
  type Token,
  type TokenId,
  type TokenValue,
} from './domain';
import type { InvokeInput, SetExecutableInput } from './executable';
import type { InvocationEvent } from './runtime';

export type ResourceWrite = { name: string; executable?: SetExecutableInput };
export type GrantWrite = { name: string; bindings: GrantBinding[]; expiresAt: string | null };
export type TokenWrite = { label: string };

export const defaultPageLimit = 50;
export const maximumPageLimit = 100;

export type Page<T> = T[];
export type ListQuery = { cursor?: string; limit?: number };
export type ResourceListQuery = ListQuery & { parentId: ResourceId | null };
export type GrantListQuery = ListQuery & { parentId?: GrantId | null };
export type TokenListQuery = ListQuery & { grantId?: GrantId };
export type AuditListQuery = ListQuery;

export function pageLimit(limit?: number) {
  const requested = Number.isFinite(limit) ? Math.floor(limit!) : defaultPageLimit;
  return Math.min(maximumPageLimit, Math.max(1, requested));
}

export function paginateRecords<T extends { id: string }>(records: T[], query: ListQuery = {}): Page<T> {
  const limit = pageLimit(query.limit);
  const start = query.cursor ? records.findIndex((record) => record.id === query.cursor) + 1 : 0;
  if (query.cursor && start === 0) throw new RgapError('invalid_cursor', 'The collection cursor is unknown.');
  return records.slice(start, start + limit);
}

export type ResourceHandle = Resource & {
  create(input: ResourceWrite): Promise<ResourceHandle>;
  move(parentId: ResourceId | null): Promise<ResourceHandle>;
  delete(): Promise<void>;
  executable: {
    get(): Promise<ExecutableDefinition | undefined>;
    set(input: SetExecutableInput): Promise<ExecutableDefinition>;
    delete(): Promise<void>;
  };
  invoke(input: InvokeInput): AsyncIterable<InvocationEvent>;
};

export type BindingsHandle = GrantBinding[] & {
  set(bindings: GrantBinding[]): Promise<GrantHandle>;
};

export type GrantHandle = Omit<Grant, 'bindings'> & {
  bindings: BindingsHandle;
  create(input: GrantWrite): Promise<GrantHandle>;
  tokens: { create(input: TokenWrite): Promise<IssuedToken> };
  revoke(): Promise<void>;
};

export type TokenHandle = Token & {
  revoke(): Promise<void>;
};

export type IssuedToken = TokenHandle & { value: TokenValue };

/**
 * Selects an authorized or explicitly administrative command plane over one backing store.
 * The store itself exposes no resource or grant commands.
 */
export interface RgapStore {
  as(token: TokenValue): RgapRepository;
  admin(): RgapRepository;
}

/**
 * The ID-based command sink adapters implement. `repositoryFrom` turns it into the handle API.
 */
export interface RgapCommands {
  getResource(id: ResourceId): Promise<Resource | undefined>;
  listResources(query: ResourceListQuery): Promise<Page<Resource>>;
  getGrant(id: GrantId): Promise<Grant | undefined>;
  listGrants(query?: GrantListQuery): Promise<Page<Grant>>;
  getToken(id: TokenId): Promise<Token | undefined>;
  listTokens(query?: TokenListQuery): Promise<Page<Token>>;
  listAudit(query?: AuditListQuery): Promise<Page<AuditEvent>>;
  createResource(input: ResourceWrite & { parentId: ResourceId | null }): Promise<Resource>;
  moveResource(id: ResourceId, parentId: ResourceId | null): Promise<Resource>;
  deleteResource(id: ResourceId): Promise<void>;
  getExecutable(resourceId: ResourceId): Promise<ExecutableDefinition | undefined>;
  setExecutable(resourceId: ResourceId, input: SetExecutableInput): Promise<ExecutableDefinition>;
  deleteExecutable(resourceId: ResourceId): Promise<void>;
  invoke(resourceId: ResourceId, input: InvokeInput): AsyncIterable<InvocationEvent>;
  createGrant(input: GrantWrite & { parentId: GrantId | null }): Promise<Grant>;
  setBindings(grantId: GrantId, bindings: GrantBinding[]): Promise<Grant>;
  issueToken(grantId: GrantId, label: string): Promise<{ record: Token; value: TokenValue }>;
  revokeToken(id: TokenId): Promise<void>;
  revokeGrant(id: GrantId): Promise<void>;
  authorize(token: TokenValue, resourceId: ResourceId, permission: Permission): Promise<Decision>;
  reset(): Promise<void>;
}

export interface RgapRepository {
  resources: {
    create(input: ResourceWrite): Promise<ResourceHandle>;
    get(id: ResourceId): Promise<ResourceHandle>;
    list(query: ResourceListQuery): Promise<Page<Resource>>;
  };
  executables: {
    get(resourceId: ResourceId): Promise<ExecutableDefinition | undefined>;
    set(resourceId: ResourceId, input: SetExecutableInput): Promise<ExecutableDefinition>;
    delete(resourceId: ResourceId): Promise<void>;
  };
  invoke(resourceId: ResourceId, input: InvokeInput): AsyncIterable<InvocationEvent>;
  grants: {
    create(input: GrantWrite): Promise<GrantHandle>;
    get(id: GrantId): Promise<GrantHandle>;
    list(query?: GrantListQuery): Promise<Page<Grant>>;
  };
  tokens: {
    get(id: TokenId): Promise<TokenHandle>;
    list(query?: TokenListQuery): Promise<Page<Token>>;
  };
  audit: {
    list(query?: AuditListQuery): Promise<Page<AuditEvent>>;
  };
  authorize(token: TokenValue, resourceId: ResourceId, permission: Permission): Promise<Decision>;
  reset(): Promise<void>;
}

export function repositoryFrom(commands: RgapCommands): RgapRepository {
  return {
    resources: {
      create: async (input) => asResource(commands, await commands.createResource({ ...input, parentId: null })),
      get: async (id) => asResource(commands, await requireResource(commands, id)),
      list: (query) => commands.listResources(query),
    },
    executables: {
      get: (resourceId) => commands.getExecutable(resourceId),
      set: (resourceId, input) => commands.setExecutable(resourceId, input),
      delete: (resourceId) => commands.deleteExecutable(resourceId),
    },
    invoke: (resourceId, input) => commands.invoke(resourceId, input),
    grants: {
      create: async (input) => asGrant(commands, await commands.createGrant({ ...input, parentId: null })),
      get: async (id) => asGrant(commands, await requireGrant(commands, id)),
      list: (query) => commands.listGrants(query),
    },
    tokens: {
      get: async (id) => asToken(commands, await requireToken(commands, id)),
      list: (query) => commands.listTokens(query),
    },
    audit: {
      list: (query) => commands.listAudit(query),
    },
    authorize: (token, resourceId, permission) => commands.authorize(token, resourceId, permission),
    reset: () => commands.reset(),
  };
}

async function requireResource(commands: RgapCommands, id: ResourceId) {
  const resource = await commands.getResource(id);
  if (!isLive(resource)) throw new RgapError('missing_resource', 'Resource does not exist.');
  return resource;
}

async function requireGrant(commands: RgapCommands, id: GrantId) {
  const grant = await commands.getGrant(id);
  if (!grant) throw new RgapError('missing_grant', 'Grant does not exist.');
  return grant;
}

async function requireToken(commands: RgapCommands, id: TokenId) {
  const token = await commands.getToken(id);
  if (!token) throw new RgapError('missing_token', 'Token does not exist.');
  return token;
}

function asResource(commands: RgapCommands, resource: Resource): ResourceHandle {
  return {
    ...resource,
    create: async (input) => asResource(commands, await commands.createResource({ ...input, parentId: resource.id })),
    move: async (parentId) => asResource(commands, await commands.moveResource(resource.id, parentId)),
    delete: () => commands.deleteResource(resource.id),
    executable: {
      get: () => commands.getExecutable(resource.id),
      set: (input) => commands.setExecutable(resource.id, input),
      delete: () => commands.deleteExecutable(resource.id),
    },
    invoke: (input) => commands.invoke(resource.id, input),
  };
}

function asGrant(commands: RgapCommands, grant: Grant): GrantHandle {
  const bindings = Object.assign([...grant.bindings], {
    set: async (entries: GrantBinding[]) => asGrant(commands, await commands.setBindings(grant.id, entries)),
  });
  return {
    ...grant,
    bindings,
    create: async (input) => asGrant(commands, await commands.createGrant({ ...input, parentId: grant.id })),
    tokens: {
      create: async (input) => asIssued(commands, await commands.issueToken(grant.id, input.label)),
    },
    revoke: () => commands.revokeGrant(grant.id),
  };
}

function asToken(commands: RgapCommands, token: Token): TokenHandle {
  return {
    ...token,
    revoke: () => commands.revokeToken(token.id),
  };
}

function asIssued(commands: RgapCommands, issued: { record: Token; value: TokenValue }): IssuedToken {
  return { ...asToken(commands, issued.record), value: issued.value };
}
