import { createStore, type StoreApi } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  authorize as decide,
  createResourceAtPath,
  createGrant as addGrant,
  deleteResource as removeResource,
  findByPath,
  inspectAuthority,
  normalizePath,
  moveResource as move,
  recordToken,
  revokeGrant as revokeGrantBranch,
  revokeToken as revokeTokenRecord,
  type CreateGrantInput,
  type CreateResourceAtPathInput,
  type Decision,
  type Grant,
  type Permission,
  type AuthorityView,
  type Resource,
  type State,
  type Token,
} from './domain';
import { seed } from './seed';

export type IssuedToken = { record: Token; value: string };

export interface RgapRepository {
  getSnapshot(): State;
  subscribe(listener: () => void): () => void;
  createResource(input: CreateResourceAtPathInput): Promise<Resource>;
  moveResource(id: string, parentPath: string): Promise<Resource>;
  deleteResource(id: string): Promise<void>;
  createGrant(input: CreateGrantInput): Promise<Grant>;
  issueToken(grantId: string, label: string): Promise<IssuedToken>;
  revokeToken(id: string): Promise<void>;
  revokeGrant(id: string): Promise<void>;
  authorize(token: string, resourceId: string, permission: Permission): Promise<Decision>;
  inspectToken(token: string): Promise<AuthorityView>;
  reset(): Promise<void>;
}

export class BrowserRgapRepository implements RgapRepository {
  private store: StoreApi<State>;

  constructor(storage?: Storage) {
    const creator = persist<State>(
      () => seed(),
      { name: 'rgap-state-v2', storage: createJSONStorage(() => storage ?? localStorage) },
    );
    this.store = createStore(creator);
  }

  getSnapshot = (): State => this.store.getState();
  subscribe = (listener: () => void) => this.store.subscribe(listener);

  async createResource(input: CreateResourceAtPathInput) {
    const result = createResourceAtPath(this.getSnapshot(), input, now());
    this.commit(result.state);
    return this.getSnapshot().resources[result.id];
  }

  async moveResource(id: string, parentPath: string) {
    const path = normalizePath(parentPath);
    const parentId = path ? findByPath(this.getSnapshot().resources, path) : null;
    if (path && !parentId) throw new Error('Destination path does not exist.');
    this.commit(move(this.getSnapshot(), id, parentId, now()));
    return this.getSnapshot().resources[id];
  }

  async deleteResource(id: string) {
    this.commit(removeResource(this.getSnapshot(), id, now()));
  }

  async createGrant(input: CreateGrantInput) {
    const id = crypto.randomUUID();
    this.commit(addGrant(this.getSnapshot(), input, id, now()));
    return this.getSnapshot().grants[id];
  }

  async issueToken(grantId: string, label: string) {
    const value = `rgap_${crypto.randomUUID().replaceAll('-', '')}`;
    const record: Token = {
      id: crypto.randomUUID(), grantId, label: label.trim() || 'unnamed token',
      hash: await hash(value), expiresAt: this.getSnapshot().grants[grantId]?.expiresAt ?? null, revokedAt: null,
    };
    this.commit(recordToken(this.getSnapshot(), record, now()));
    return { record, value };
  }

  async revokeToken(id: string) {
    this.commit(revokeTokenRecord(this.getSnapshot(), id, now()));
  }

  async revokeGrant(id: string) {
    this.commit(revokeGrantBranch(this.getSnapshot(), id, now()));
  }

  async authorize(token: string, resourceId: string, permission: Permission) {
    const at = now();
    const decision = decide(this.getSnapshot(), await hash(token), resourceId, permission, at);
    const state = structuredClone(this.getSnapshot());
    state.audit.unshift({
      id: crypto.randomUUID(), at, action: 'authorize', target: resourceId,
      result: decision.allowed ? 'allowed' : 'denied', detail: decision.detail,
    });
    this.commit(state);
    return decision;
  }

  async inspectToken(token: string) {
    return inspectAuthority(this.getSnapshot(), await hash(token), now());
  }

  async reset() {
    this.commit(seed());
  }

  private commit(state: State) {
    this.store.setState(state, true);
  }
}

const now = () => new Date().toISOString();

async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
