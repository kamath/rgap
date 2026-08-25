import { SqliteCredentialStore } from '@rgap/local-credential-store';
import { describe, expect, it } from 'vitest';
import {
  OAuthFlowStore,
  type OAuthFlowRecord,
  stateKey,
} from './oauth-flow-store';

const flow = {
  flowId: 'flow_1',
  credentialId: 'credential_1',
  serverUrl: 'https://mcp.example.com/mcp',
  expiresAt: '2026-08-24T09:00:00.000Z',
} satisfies OAuthFlowRecord;

describe('OAuthFlowStore', () => {
  it('stores flows under a state hash and claims them once', async () => {
    const records = new SqliteCredentialStore<OAuthFlowRecord>();
    const flows = new OAuthFlowStore(records);
    await flows.register('secret-state', flow);

    expect(await records.get('secret-state')).toBeUndefined();
    expect(await records.get(stateKey('secret-state'))).toEqual(flow);

    const claimed = await flows.claim(
      'secret-state',
      new Date('2026-08-24T08:00:00.000Z'),
    );
    expect(claimed.claimedAt).toBe('2026-08-24T08:00:00.000Z');
    expect(() => flows.claim(
      'secret-state',
      new Date('2026-08-24T08:01:00.000Z'),
    )).toThrow('already consumed');
    await flows.close();
  });

  it('rejects unknown and expired states', async () => {
    const records = new SqliteCredentialStore<OAuthFlowRecord>();
    const flows = new OAuthFlowStore(records);

    expect(() => flows.claim('unknown')).toThrow('invalid');
    await flows.register('expired', flow);
    expect(() => flows.claim(
      'expired',
      new Date('2026-08-24T09:00:00.000Z'),
    )).toThrow('expired');
    await flows.close();
  });
});
