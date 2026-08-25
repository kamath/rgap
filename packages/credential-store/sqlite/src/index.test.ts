import { describe, expect, it } from 'vitest';
import { SqliteCredentialStore } from './index';

describe('SqliteCredentialStore', () => {
  it('stores, updates, and deletes JSON credential records', () => {
    const store = new SqliteCredentialStore<{ accessToken: string; refreshes: number }>();

    expect(store.get('credential_1')).toBeUndefined();
    store.set('credential_1', { accessToken: 'secret', refreshes: 0 });
    expect(store.get('credential_1')).toEqual({
      accessToken: 'secret',
      refreshes: 0,
    });

    const updated = store.update('credential_1', (current) => ({
      accessToken: current!.accessToken,
      refreshes: current!.refreshes + 1,
    }));
    expect(updated.refreshes).toBe(1);
    expect(store.get('credential_1')?.refreshes).toBe(1);

    store.delete('credential_1');
    expect(store.get('credential_1')).toBeUndefined();
    store.close();
  });

  it('rolls back an update that throws', () => {
    const store = new SqliteCredentialStore<{ value: string }>();
    store.set('credential_1', { value: 'before' });

    expect(() => store.update('credential_1', () => {
      throw new Error('failed refresh');
    })).toThrow('failed refresh');
    expect(store.get('credential_1')).toEqual({ value: 'before' });
    store.close();
  });

  it('rejects values that JSON cannot encode', () => {
    const store = new SqliteCredentialStore<undefined>();
    expect(() => store.set('credential_1', undefined)).toThrow(
      'Credential values must be JSON-serializable.',
    );
    store.close();
  });
});
