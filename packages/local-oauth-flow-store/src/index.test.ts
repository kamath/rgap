import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  type OAuthFlowRecord,
  type OAuthFlowStore,
  SqliteOAuthFlowStore,
} from './index';

const flow = {
  flowId: 'flow_1',
  credentialId: 'credential_1',
  serverUrl: 'https://mcp.example.com/mcp',
  expiresAt: '2026-08-25T09:00:00.000Z',
} satisfies OAuthFlowRecord;

describe('SqliteOAuthFlowStore', () => {
  it('implements the storage-independent interface', async () => {
    const store: OAuthFlowStore = new SqliteOAuthFlowStore();
    await store.register('state', flow);
    await expect(store.claim(
      'state',
      new Date('2026-08-25T08:00:00.000Z'),
    )).resolves.toMatchObject(flow);
    await store.close();
  });

  it('stores state hashes and claims each flow once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rgap-oauth-flow-'));
    const path = join(directory, 'flows.db');
    const store = new SqliteOAuthFlowStore(path);
    let closed = false;
    try {
      await store.register('secret-state', flow);
      const claimed = await store.claim(
        'secret-state',
        new Date('2026-08-25T08:00:00.000Z'),
      );
      expect(claimed).toEqual({
        ...flow,
        claimedAt: '2026-08-25T08:00:00.000Z',
      });
      await expect(store.claim('secret-state')).rejects.toThrow(
        'already consumed',
      );
      await store.close();
      closed = true;

      const database = new Database(path, { readonly: true });
      const states = database.prepare(
        'SELECT state_hash FROM oauth_flows',
      ).pluck().all();
      expect(states).toEqual([
        createHash('sha256').update('secret-state').digest('hex'),
      ]);
      database.close();
    } finally {
      if (!closed) await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unknown and expired states', async () => {
    const store = new SqliteOAuthFlowStore();
    await expect(store.claim('unknown')).rejects.toThrow('invalid');
    await store.register('expired', flow);
    await expect(store.claim(
      'expired',
      new Date('2026-08-25T09:00:00.000Z'),
    )).rejects.toThrow('expired');
    await store.close();
  });

  it('deletes completed flows', async () => {
    const store = new SqliteOAuthFlowStore();
    await store.register('state', flow);
    await store.complete('state');
    await expect(store.claim('state')).rejects.toThrow('invalid');
    await store.close();
  });
});
