import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CredentialStore,
  PostgresCredentialStore,
} from './index';

const databaseUrl = process.env.TEST_POSTGRES_URL;
const postgres = databaseUrl ? describe : describe.skip;

postgres('PostgresCredentialStore', () => {
  const createStore = async <T>() => {
    const store = new PostgresCredentialStore<T>({
      url: databaseUrl!,
      connection: { max: 2 },
    });
    await store.migrate();
    return store;
  };

  it('implements the storage-independent interface', async () => {
    const store: CredentialStore<{ value: string }> = await createStore();
    const id = randomUUID();
    try {
      await store.set(id, { value: 'stored' });
      await expect(store.get(id)).resolves.toEqual({ value: 'stored' });
      await store.delete(id);
      await expect(store.get(id)).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('serializes concurrent updates, including the first insert', async () => {
    const store = await createStore<{ refreshes: number }>();
    const id = randomUUID();
    try {
      const update = () => store.update(id, (current) => ({
        refreshes: (current?.refreshes ?? 0) + 1,
      }));
      await Promise.all([update(), update(), update()]);
      await expect(store.get(id)).resolves.toEqual({ refreshes: 3 });
    } finally {
      await store.delete(id);
      await store.close();
    }
  });

  it('rolls back an update that throws', async () => {
    const store = await createStore<{ value: string }>();
    const id = randomUUID();
    try {
      await store.set(id, { value: 'before' });
      await expect(store.update(id, () => {
        throw new Error('failed refresh');
      })).rejects.toThrow('failed refresh');
      await expect(store.get(id)).resolves.toEqual({ value: 'before' });
    } finally {
      await store.delete(id);
      await store.close();
    }
  });

  it('rejects values that JSON cannot encode', async () => {
    const store = await createStore<undefined>();
    try {
      await expect(store.set(randomUUID(), undefined)).rejects.toThrow(
        'Credential values must be JSON-serializable.',
      );
    } finally {
      await store.close();
    }
  });
});
