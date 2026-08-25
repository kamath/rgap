import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  RgapError,
  resourceId,
  type RgapRepository,
  type State,
} from '@rgap/core';
import { PostgresRgapStore } from './index';

const databaseUrl = process.env.TEST_POSTGRES_URL;
const postgres = databaseUrl ? describe : describe.skip;

const initialState = (): State => ({
  resources: {
    acme: {
      id: resourceId('acme'),
      parentId: null,
      name: 'acme',
      deletedAt: null,
      executable: null,
    },
  },
  grants: {},
  tokens: {},
  audit: [],
});

postgres('PostgresRgapStore', () => {
  it('exposes command planes and adapter lifecycle methods', () => {
    const store = new PostgresRgapStore({ url: databaseUrl! });

    expectTypeOf<
      Extract<keyof PostgresRgapStore, keyof RgapRepository>
    >().toEqualTypeOf<never>();
    expect(store).not.toHaveProperty('resources');

    return store.close();
  });

  it('migrates explicitly and preserves populated state', async () => {
    const store = new PostgresRgapStore({
      url: databaseUrl!,
      initialState: initialState(),
      connection: { max: 1 },
    });

    try {
      await expect(
        store.admin().resources.list({ parentId: null }),
      ).rejects.toBeTruthy();

      await store.migrate();
      expect(await store.admin().resources.list({ parentId: null })).toEqual([
        expect.objectContaining({ id: 'acme', name: 'acme' }),
      ]);

      await store.admin().resources.create({ name: 'platform' });
    } finally {
      await store.close();
    }

    const reopened = new PostgresRgapStore({
      url: databaseUrl!,
      initialState: {
        resources: {
          replacement: {
            id: resourceId('replacement'),
            parentId: null,
            name: 'replacement',
            deletedAt: null,
            executable: null,
          },
        },
        grants: {},
        tokens: {},
        audit: [],
      },
    });

    try {
      await reopened.migrate();
      const roots = await reopened.admin().resources.list({ parentId: null });
      expect(roots.map(({ id }) => id).sort()).toEqual(['acme', 'platform']);
    } finally {
      await reopened.close();
    }
  });

  it('rolls back rejected commands and resets to initial state', async () => {
    const store = new PostgresRgapStore({
      url: databaseUrl!,
      initialState: initialState(),
    });

    try {
      await store.migrate();
      const admin = store.admin();
      await admin.reset();
      const before = await admin.audit.list();

      await expect(
        admin.resources.create({ name: 'acme' }),
      ).rejects.toBeInstanceOf(RgapError);

      expect(await admin.audit.list()).toEqual(before);
      expect(await admin.resources.list({ parentId: null })).toEqual([
        expect.objectContaining({ id: 'acme' }),
      ]);
    } finally {
      await store.close();
    }
  });
});
