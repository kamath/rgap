import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  tokenValue,
  type AuditEvent,
  type AuditListQuery,
  type AuthorityView,
  type Capability,
  type Decision,
  type Grant,
  type GrantHandle,
  type GrantId,
  type GrantListQuery,
  type GrantWrite,
  type IssuedToken,
  type Page,
  type Permission,
  type Resource,
  type ResourceHandle,
  type ResourceId,
  type ResourceListQuery,
  type ResourceWrite,
  type RgapRepository,
  type Token,
  type TokenHandle,
  type TokenListQuery,
  type TokenValue,
  type TokenWrite,
} from '@rgap/core';

type Listener = () => void;
type QueryKind = 'resources' | 'grants' | 'tokens' | 'audit';
const queryKey = (kind: QueryKind, query: object = {}) => `${kind}:${JSON.stringify(query)}`;

export class RgapClient implements RgapRepository {
  private listeners = new Set<Listener>();
  private version = 0;
  private pages = new Map<string, Page<unknown>>();
  private pending = new Map<string, Promise<Page<unknown>>>();
  private resourceRecords: Record<string, Resource> = {};
  private grantRecords: Record<string, Grant> = {};
  private tokenRecords: Record<string, Token> = {};

  private constructor(private repository: RgapRepository) {}

  static async connect(repository: RgapRepository) {
    return new RgapClient(repository);
  }

  getVersion = () => this.version;
  getResourceRecords = () => this.resourceRecords;
  getGrantRecords = () => this.grantRecords;

  /** Swaps the command plane and clears records that the new plane may not expose. */
  setRepository(repository: RgapRepository) {
    this.repository = repository;
    this.invalidateAll(true);
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  invalidateAll(clearRecords = false) {
    this.pages.clear();
    this.pending.clear();
    if (clearRecords) {
      this.resourceRecords = {};
      this.grantRecords = {};
      this.tokenRecords = {};
    }
    this.emit();
  }

  resources = {
    create: (input: ResourceWrite) => this.run(
      async () => this.wrapResource(await this.repository.resources.create(input)),
      ['resources', 'audit'],
    ),
    get: async (id: ResourceId) => {
      const resource = this.wrapResource(await this.repository.resources.get(id));
      this.cacheResource(resource);
      return resource;
    },
    list: (query: ResourceListQuery = {}) => this.loadPage('resources', query, async () => {
      const page = await this.repository.resources.list(query);
      page.records.forEach((record) => this.cacheResource(record, false));
      return page;
    }),
  };

  grants = {
    create: (input: GrantWrite) => this.run(
      async () => this.wrapGrant(await this.repository.grants.create(input)),
      ['grants', 'audit'],
    ),
    get: async (id: GrantId) => {
      const grant = this.wrapGrant(await this.repository.grants.get(id));
      this.cacheGrant(grant);
      return grant;
    },
    list: (query: GrantListQuery = {}) => this.loadPage('grants', query, async () => {
      const page = await this.repository.grants.list(query);
      page.records.forEach((record) => this.cacheGrant(record, false));
      return page;
    }),
  };

  tokens = {
    get: async (id: TokenHandle['id']) => {
      const record = this.wrapToken(await this.repository.tokens.get(id));
      this.cacheToken(record);
      return record;
    },
    list: (query: TokenListQuery = {}) => this.loadPage('tokens', query, async () => {
      const page = await this.repository.tokens.list(query);
      page.records.forEach((record) => this.cacheToken(record, false));
      return page;
    }),
  };

  audit = {
    list: (query: AuditListQuery = {}) =>
      this.loadPage('audit', query, () => this.repository.audit.list(query)),
  };

  authorize(token: TokenValue, resourceId: ResourceId, permission: Permission): Promise<Decision> {
    return this.run(() => this.repository.authorize(token, resourceId, permission), ['audit']);
  }

  inspectToken(token: TokenValue): Promise<AuthorityView> {
    return this.repository.inspectToken(token);
  }

  reset(): Promise<void> {
    return this.run(() => this.repository.reset(), ['resources', 'grants', 'tokens', 'audit'], true);
  }

  peekPage<T>(kind: QueryKind, query: object = {}) {
    return this.pages.get(queryKey(kind, query)) as Page<T> | undefined;
  }

  private loadPage<T extends { id: string }>(
    kind: QueryKind,
    query: object,
    load: () => Promise<Page<T>>,
  ): Promise<Page<T>> {
    const key = queryKey(kind, query);
    const cached = this.pages.get(key) as Page<T> | undefined;
    if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(key) as Promise<Page<T>> | undefined;
    if (existing) return existing;
    const request = load().then((page) => {
      this.pages.set(key, page);
      this.pending.delete(key);
      this.emit();
      return page;
    }, (error) => {
      this.pending.delete(key);
      throw error;
    });
    this.pending.set(key, request);
    return request;
  }

  private wrapResource(resource: ResourceHandle): ResourceHandle {
    return {
      ...resource,
      create: (input) => this.run(async () => this.wrapResource(await resource.create(input)), ['resources', 'audit']),
      move: (parentId) => this.run(async () => this.wrapResource(await resource.move(parentId)), ['resources', 'audit']),
      delete: () => this.run(() => resource.delete(), ['resources', 'audit']),
    };
  }

  private wrapGrant(grant: GrantHandle): GrantHandle {
    const capabilities = Object.assign([...grant.capabilities], {
      set: (entries: Capability[]) =>
        this.run(async () => this.wrapGrant(await grant.capabilities.set(entries)), ['grants', 'audit']),
    });
    return {
      ...grant,
      capabilities,
      create: (input) => this.run(async () => this.wrapGrant(await grant.create(input)), ['grants', 'audit']),
      tokens: {
        create: (input: TokenWrite) =>
          this.run(async () => this.wrapIssued(await grant.tokens.create(input)), ['tokens', 'audit']),
      },
      revoke: () => this.run(() => grant.revoke(), ['grants', 'tokens', 'audit']),
    };
  }

  private wrapToken(token: TokenHandle): TokenHandle {
    return {
      ...token,
      revoke: () => this.run(() => token.revoke(), ['tokens', 'audit']),
    };
  }

  private wrapIssued(issued: IssuedToken): IssuedToken {
    return { ...this.wrapToken(issued), value: issued.value };
  }

  private cacheResource(resource: Resource, emit = true) {
    this.resourceRecords = {
      ...this.resourceRecords,
      [resource.id]: {
        id: resource.id, parentId: resource.parentId, name: resource.name, deletedAt: resource.deletedAt,
      },
    };
    if (emit) this.emit();
  }

  private cacheGrant(grant: Grant, emit = true) {
    this.grantRecords = {
      ...this.grantRecords,
      [grant.id]: {
        id: grant.id, parentId: grant.parentId, name: grant.name, capabilities: [...grant.capabilities],
        expiresAt: grant.expiresAt, revokedAt: grant.revokedAt,
      },
    };
    if (emit) this.emit();
  }

  private cacheToken(token: Token, emit = true) {
    this.tokenRecords = {
      ...this.tokenRecords,
      [token.id]: {
        id: token.id, grantId: token.grantId, label: token.label, hash: token.hash,
        expiresAt: token.expiresAt, revokedAt: token.revokedAt,
      },
    };
    if (emit) this.emit();
  }

  private async run<T>(command: () => Promise<T>, kinds: QueryKind[], clearRecords = false) {
    const result = await command();
    if (isResource(result)) this.cacheResource(result, false);
    if (isGrant(result)) this.cacheGrant(result, false);
    if (isToken(result)) this.cacheToken(result, false);
    if (clearRecords) {
      this.resourceRecords = {};
      this.grantRecords = {};
      this.tokenRecords = {};
    }
    for (const key of this.pages.keys()) {
      if (kinds.some((kind) => key.startsWith(`${kind}:`))) this.pages.delete(key);
    }
    this.emit();
    return result;
  }

  private emit() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}

const isResource = (value: unknown): value is Resource =>
  Boolean(value && typeof value === 'object' && 'deletedAt' in value && 'parentId' in value && !('capabilities' in value));
const isGrant = (value: unknown): value is Grant =>
  Boolean(value && typeof value === 'object' && 'capabilities' in value);
const isToken = (value: unknown): value is Token =>
  Boolean(value && typeof value === 'object' && 'grantId' in value && 'hash' in value);

const ClientContext = createContext<RgapClient | null>(null);

export function RgapProvider({ client, children }: { client: RgapClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useRgapClient() {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useRgapClient must be used inside RgapProvider.');
  return client;
}

const useVersion = (client: RgapClient) => useSyncExternalStore(client.subscribe, client.getVersion);

function usePage<T extends { id: string }, Q extends object>(
  kind: QueryKind,
  query: Q,
  load: (query: Q) => Promise<Page<T>>,
) {
  const client = useRgapClient();
  const version = useVersion(client);
  const serialized = JSON.stringify(query);
  const page = client.peekPage<T>(kind, query);
  useEffect(() => {
    if (!page) void load(query).catch(() => undefined);
  }, [client, load, page, serialized, version]);
  return { records: page?.records ?? [], cursor: page?.cursor ?? null, loading: !page };
}

export function useResourceList(query: ResourceListQuery = {}) {
  const client = useRgapClient();
  return usePage('resources', query, client.resources.list);
}

export function useGrantList(query: GrantListQuery = {}) {
  const client = useRgapClient();
  return usePage('grants', query, client.grants.list);
}

export function useTokenList(query: TokenListQuery = {}) {
  const client = useRgapClient();
  return usePage('tokens', query, client.tokens.list);
}

export function useAudit(query: AuditListQuery = {}) {
  const client = useRgapClient();
  return usePage<AuditEvent, AuditListQuery>('audit', query, client.audit.list);
}

export function useResourceRecords() {
  const client = useRgapClient();
  useVersion(client);
  return client.getResourceRecords();
}

export function useGrantRecords() {
  const client = useRgapClient();
  useVersion(client);
  return client.getGrantRecords();
}

export function useResource(id: ResourceId | null) {
  const client = useRgapClient();
  const records = useResourceRecords();
  useEffect(() => {
    if (id && !records[id]) void client.resources.get(id).catch(() => undefined);
  }, [client, id, records]);
  return id ? records[id] ?? null : null;
}

export function useGrant(id: GrantId | null) {
  const client = useRgapClient();
  const records = useGrantRecords();
  useEffect(() => {
    if (id && !records[id]) void client.grants.get(id).catch(() => undefined);
  }, [client, id, records]);
  return id ? records[id] ?? null : null;
}

export function useGrantLineage(id: GrantId | null) {
  const client = useRgapClient();
  const records = useGrantRecords();
  useEffect(() => {
    if (!id) return;
    void (async () => {
      let current: GrantId | null = id;
      while (current) {
        const record: Grant = records[current] ?? await client.grants.get(current);
        current = record.parentId;
      }
    })().catch(() => undefined);
  }, [client, id, records]);
  const lineage: Grant[] = [];
  for (let current = id; current && records[current]; current = records[current].parentId) {
    lineage.unshift(records[current]);
  }
  return lineage;
}

export function useResolvedPath(path: string) {
  const client = useRgapClient();
  const version = useVersion(client);
  const [result, setResult] = useState<{ resourceId: ResourceId | null; missing: boolean }>({
    resourceId: null, missing: false,
  });
  useEffect(() => {
    let current = true;
    void (async () => {
      let parentId: ResourceId | null = null;
      for (const name of path.split('/').filter(Boolean)) {
        const page = await client.resources.list({ parentId, limit: 100 });
        const resource = page.records.find((record) => record.name === name);
        if (!resource) {
          if (current) setResult({ resourceId: null, missing: true });
          return;
        }
        parentId = resource.id;
      }
      if (current) setResult({ resourceId: parentId, missing: false });
    })().catch(() => { if (current) setResult({ resourceId: null, missing: true }); });
    return () => { current = false; };
  }, [client, path, version]);
  return result;
}

export function useRgapAuthority(token: string) {
  const client = useRgapClient();
  const version = useVersion(client);
  const [authority, setAuthority] = useState<AuthorityView | null>(null);
  useEffect(() => {
    if (!token.trim()) {
      setAuthority(null);
      return;
    }
    setAuthority(null);
    let current = true;
    client.inspectToken(tokenValue(token)).then((result) => { if (current) setAuthority(result); });
    return () => { current = false; };
  }, [client, token, version]);
  return { authority, loading: Boolean(token.trim()) && !authority };
}
