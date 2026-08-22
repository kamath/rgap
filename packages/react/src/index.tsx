import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {
  AuthorityView,
  Capability,
  Decision,
  GrantHandle,
  GrantWrite,
  IssuedToken,
  Permission,
  ResourceHandle,
  ResourceId,
  ResourceWrite,
  RgapRepository,
  State,
  TokenHandle,
  TokenValue,
  TokenWrite,
} from '@rgap/core';
import { tokenValue } from '@rgap/core';

type Listener = () => void;

export class RgapClient implements RgapRepository {
  private listeners = new Set<Listener>();

  private constructor(private repository: RgapRepository, private snapshot: State) {}

  static async connect(repository: RgapRepository) {
    return new RgapClient(repository, await repository.readState());
  }

  getSnapshot = () => this.snapshot;

  /** Swaps the repository commands run against, such as an administrative plane for a guarded one. */
  setRepository(repository: RgapRepository) {
    this.repository = repository;
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh() {
    this.snapshot = await this.repository.readState();
    this.listeners.forEach((listener) => listener());
  }

  resources = {
    create: (input: ResourceWrite) => this.run(async () => this.wrapResource(await this.repository.resources.create(input))),
    get: async (id: ResourceId) => this.wrapResource(await this.repository.resources.get(id)),
  };

  grants = {
    create: (input: GrantWrite) => this.run(async () => this.wrapGrant(await this.repository.grants.create(input))),
    get: async (id: GrantHandle['id']) => this.wrapGrant(await this.repository.grants.get(id)),
  };

  tokens = {
    get: async (id: TokenHandle['id']) => this.wrapToken(await this.repository.tokens.get(id)),
  };

  readState(): Promise<State> {
    return this.repository.readState();
  }

  authorize(token: TokenValue, resourceId: ResourceId, permission: Permission): Promise<Decision> {
    return this.run(() => this.repository.authorize(token, resourceId, permission));
  }

  inspectToken(token: TokenValue): Promise<AuthorityView> {
    return this.repository.inspectToken(token);
  }

  reset(): Promise<void> {
    return this.run(() => this.repository.reset());
  }

  private wrapResource(resource: ResourceHandle): ResourceHandle {
    return {
      ...resource,
      create: (input) => this.run(async () => this.wrapResource(await resource.create(input))),
      move: (parentId) => this.run(async () => this.wrapResource(await resource.move(parentId))),
      delete: () => this.run(() => resource.delete()),
    };
  }

  private wrapGrant(grant: GrantHandle): GrantHandle {
    const capabilities = Object.assign([...grant.capabilities], {
      set: (entries: Capability[]) => this.run(async () => this.wrapGrant(await grant.capabilities.set(entries))),
    });
    return {
      ...grant,
      capabilities,
      create: (input) => this.run(async () => this.wrapGrant(await grant.create(input))),
      tokens: {
        create: (input: TokenWrite) => this.run(async () => this.wrapIssued(await grant.tokens.create(input))),
      },
      revoke: () => this.run(() => grant.revoke()),
    };
  }

  private wrapToken(token: TokenHandle): TokenHandle {
    return {
      ...token,
      revoke: () => this.run(() => token.revoke()),
    };
  }

  private wrapIssued(issued: IssuedToken): IssuedToken {
    return { ...this.wrapToken(issued), value: issued.value };
  }

  private async run<T>(command: () => Promise<T>) {
    const result = await command();
    await this.refresh();
    return result;
  }
}

const ClientContext = createContext<RgapClient | null>(null);

export function RgapProvider({ client, children }: { client: RgapClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useRgapClient() {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useRgapClient must be used inside RgapProvider.');
  return client;
}

export function useRgapSnapshot() {
  const client = useRgapClient();
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

export function useRgapAuthority(token: string) {
  const client = useRgapClient();
  const snapshot = useRgapSnapshot();
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
  }, [client, snapshot, token]);

  return { authority, loading: Boolean(token.trim()) && !authority };
}
