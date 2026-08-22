import { createStore, type StoreApi } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  authorize as decide,
  availableId,
  createResource as addResource,
  createGrant as addGrant,
  deleteResource as removeResource,
  guardCommands,
  inspectAuthority,
  moveResource as move,
  recordToken,
  revokeGrant as revokeGrantBranch,
  stateIntegrity,
  revokeToken as revokeTokenRecord,
  setCapabilities as amendCapabilities,
  type Capability,
  type CreateGrantInput,
  type CreateResourceInput,
  type Permission,
  type RgapStore,
  type State,
  type Token,
  type RgapRepository,
} from '@rgap/core';

export type BrowserRgapStoreOptions = {
  initialState: State;
  storage?: Storage;
  storageKey?: string;
};

export class BrowserRgapStore implements RgapStore {
  private readonly repository: BrowserBackingRepository;

  constructor(options: BrowserRgapStoreOptions) {
    this.repository = new BrowserBackingRepository(options);
  }

  admin(): RgapRepository {
    return this.repository;
  }

  as(token: string): RgapRepository {
    return guardCommands(this.repository, token);
  }
}

class BrowserBackingRepository implements RgapRepository {
  private store: StoreApi<State>;
  private initialState: State;

  constructor(options: BrowserRgapStoreOptions) {
    this.initialState = structuredClone(options.initialState);
    const creator = persist<State>(
      () => structuredClone(this.initialState),
      {
        name: options.storageKey ?? 'rgap-state',
        storage: createJSONStorage(() => options.storage ?? localStorage),
        // Stored state whose references no longer resolve cannot be read at all, so it is discarded
        // for the initial state rather than loaded into records that name resources that are gone.
        merge: (persisted, initial) => {
          const problems = persisted ? stateIntegrity(persisted as State) : ['No stored state.'];
          if (!problems.length) return persisted as State;
          return initial;
        },
      },
    );
    this.store = createStore(creator);
  }

  async readState(): Promise<State> {
    return structuredClone(this.currentState());
  }

  async createResource(input: CreateResourceInput) {
    const id = availableId(this.currentState(), input.name);
    this.commit(addResource(this.currentState(), input, id, now()));
    return this.currentState().resources[id];
  }

  async moveResource(id: string, parentId: string | null) {
    this.commit(move(this.currentState(), id, parentId, now()));
    return this.currentState().resources[id];
  }

  async deleteResource(id: string) {
    this.commit(removeResource(this.currentState(), id, now()));
  }

  async createGrant(input: CreateGrantInput) {
    const id = crypto.randomUUID();
    this.commit(addGrant(this.currentState(), input, id, now()));
    return this.currentState().grants[id];
  }

  async setCapabilities(grantId: string, capabilities: Capability[]) {
    this.commit(amendCapabilities(this.currentState(), grantId, capabilities, now()));
    return this.currentState().grants[grantId];
  }

  async issueToken(grantId: string, label: string) {
    const value = `rgap_${crypto.randomUUID().replaceAll('-', '')}`;
    const record: Token = {
      id: crypto.randomUUID(), grantId, label: label.trim() || 'unnamed token',
      hash: await hash(value), expiresAt: this.currentState().grants[grantId]?.expiresAt ?? null, revokedAt: null,
    };
    this.commit(recordToken(this.currentState(), record, now()));
    return { record, value };
  }

  async revokeToken(id: string) {
    this.commit(revokeTokenRecord(this.currentState(), id, now()));
  }

  async revokeGrant(id: string) {
    this.commit(revokeGrantBranch(this.currentState(), id, now()));
  }

  async authorize(token: string, resourceId: string, permission: Permission) {
    const at = now();
    const decision = decide(this.currentState(), await hash(token), resourceId, permission, at);
    const state = structuredClone(this.currentState());
    state.audit.unshift({
      id: crypto.randomUUID(), at, action: 'authorize', target: resourceId,
      result: decision.allowed ? 'allowed' : 'denied', detail: decision.detail,
    });
    this.commit(state);
    return decision;
  }

  async inspectToken(token: string) {
    return inspectAuthority(this.currentState(), await hash(token), now());
  }

  async reset() {
    this.commit(structuredClone(this.initialState));
  }

  private commit(state: State) {
    this.store.setState(state, true);
  }

  private currentState() {
    return this.store.getState();
  }
}

const now = () => new Date().toISOString();

async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
