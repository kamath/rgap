import { SqliteCredentialStore } from '@rgap/credential-store-sqlite';
import { describe, expect, it } from 'vitest';
import {
  type McpCredential,
  PersistentOAuthProvider,
  oauthClientMetadataDocument,
} from './oauth-provider';

const callbackUrl = new URL('https://proxy.example.com/oauth/callback');
const clientMetadataUrl = new URL(
  'https://proxy.example.com/oauth/client-metadata.json',
);

describe('PersistentOAuthProvider', () => {
  it('publishes fixed callback metadata for CIMD', () => {
    expect(oauthClientMetadataDocument(
      clientMetadataUrl,
      callbackUrl,
      'https://proxy.example.com',
    )).toEqual({
      client_id: clientMetadataUrl.toString(),
      client_uri: 'https://proxy.example.com',
      client_name: 'RGAP MCP proxy',
      redirect_uris: [callbackUrl.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('supplies the CIMD URL and replaces expired callback state', async () => {
    const store = new SqliteCredentialStore<McpCredential>();
    const provider = new PersistentOAuthProvider({
      credentialId: 'credential_1',
      callbackUrl,
      clientMetadataUrl: clientMetadataUrl.toString(),
      store,
    });
    await provider.begin({
      flowId: 'expired-flow',
      state: 'expired-state',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    const state = await provider.state();
    expect(state).not.toBe('expired-state');
    expect(provider.clientMetadataUrl).toBe(clientMetadataUrl.toString());
    expect((await store.get('credential_1'))?.pendingAuthorization).toMatchObject({
      state,
    });
    store.close();
  });
});
