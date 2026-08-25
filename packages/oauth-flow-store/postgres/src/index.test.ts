import { createHash, randomUUID } from 'node:crypto';
import postgresClient from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  type OAuthFlowRecord,
  type OAuthFlowStore,
  PostgresOAuthFlowStore,
} from './index';

const databaseUrl = process.env.TEST_POSTGRES_URL;
const postgres = databaseUrl ? describe : describe.skip;

const flow = {
  flowId: 'flow_1',
  credentialId: 'credential_1',
  serverUrl: 'https://mcp.example.com/mcp',
  expiresAt: '2026-08-25T09:00:00.000Z',
} satisfies OAuthFlowRecord;

postgres('PostgresOAuthFlowStore', () => {
  const createStore = async () => {
    const store = new PostgresOAuthFlowStore({
      url: databaseUrl!,
      connection: { max: 2 },
    });
    await store.migrate();
    return store;
  };

  it('implements the storage-independent interface', async () => {
    const store: OAuthFlowStore = await createStore();
    const state = randomUUID();
    try {
      await store.register(state, flow);
      await expect(store.claim(
        state,
        new Date('2026-08-25T08:00:00.000Z'),
      )).resolves.toMatchObject(flow);
    } finally {
      await store.complete(state);
      await store.close();
    }
  });

  it('stores state hashes and claims each flow once', async () => {
    const store = await createStore();
    const state = randomUUID();
    const connection = postgresClient(databaseUrl!, { max: 1 });
    try {
      await store.register(state, flow);
      await expect(store.claim(
        state,
        new Date('2026-08-25T08:00:00.000Z'),
      )).resolves.toEqual({
        ...flow,
        claimedAt: '2026-08-25T08:00:00.000Z',
      });
      await expect(store.claim(state)).rejects.toThrow('already consumed');

      const rows = await connection<{ state_hash: string }[]>`
        SELECT state_hash
        FROM oauth_flows
        WHERE state_hash = ${createHash('sha256').update(state).digest('hex')}
      `;
      expect(rows).toHaveLength(1);
    } finally {
      await store.complete(state);
      await connection.end();
      await store.close();
    }
  });

  it('allows only one concurrent claim', async () => {
    const store = await createStore();
    const state = randomUUID();
    try {
      await store.register(state, flow);
      const results = await Promise.allSettled([
        store.claim(state, new Date('2026-08-25T08:00:00.000Z')),
        store.claim(state, new Date('2026-08-25T08:00:00.000Z')),
      ]);
      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    } finally {
      await store.complete(state);
      await store.close();
    }
  });

  it('rejects unknown and expired states', async () => {
    const store = await createStore();
    const expiredState = randomUUID();
    try {
      await expect(store.claim(randomUUID())).rejects.toThrow('invalid');
      await store.register(expiredState, flow);
      await expect(store.claim(
        expiredState,
        new Date('2026-08-25T09:00:00.000Z'),
      )).rejects.toThrow('expired');
    } finally {
      await store.complete(expiredState);
      await store.close();
    }
  });

  it('deletes completed flows', async () => {
    const store = await createStore();
    const state = randomUUID();
    try {
      await store.register(state, flow);
      await store.complete(state);
      await expect(store.claim(state)).rejects.toThrow('invalid');
    } finally {
      await store.close();
    }
  });
});
