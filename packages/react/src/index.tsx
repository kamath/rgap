import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type {
  AuthorityView,
  CreateGrantInput,
  CreateResourceAtPathInput,
  Decision,
  Grant,
  IssuedToken,
  Permission,
  Resource,
  RgapRepository,
  State,
} from '@rgap/core';

type Listener = () => void;

export class RgapClient {
  private listeners = new Set<Listener>();

  private constructor(private repository: RgapRepository, private snapshot: State) {}

  static async connect(repository: RgapRepository) {
    return new RgapClient(repository, await repository.readState());
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh() {
    this.snapshot = await this.repository.readState();
    this.listeners.forEach((listener) => listener());
  }

  createResource(input: CreateResourceAtPathInput): Promise<Resource> {
    return this.run(() => this.repository.createResource(input));
  }

  moveResource(id: string, parentPath: string): Promise<Resource> {
    return this.run(() => this.repository.moveResource(id, parentPath));
  }

  deleteResource(id: string): Promise<void> {
    return this.run(() => this.repository.deleteResource(id));
  }

  createGrant(input: CreateGrantInput): Promise<Grant> {
    return this.run(() => this.repository.createGrant(input));
  }

  issueToken(grantId: string, label: string): Promise<IssuedToken> {
    return this.run(() => this.repository.issueToken(grantId, label));
  }

  revokeToken(id: string): Promise<void> {
    return this.run(() => this.repository.revokeToken(id));
  }

  revokeGrant(id: string): Promise<void> {
    return this.run(() => this.repository.revokeGrant(id));
  }

  authorize(token: string, resourceId: string, permission: Permission): Promise<Decision> {
    return this.run(() => this.repository.authorize(token, resourceId, permission));
  }

  inspectToken(token: string): Promise<AuthorityView> {
    return this.repository.inspectToken(token);
  }

  reset(): Promise<void> {
    return this.run(() => this.repository.reset());
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
    client.inspectToken(token).then((result) => { if (current) setAuthority(result); });
    return () => { current = false; };
  }, [client, snapshot, token]);

  return { authority, loading: Boolean(token.trim()) && !authority };
}
