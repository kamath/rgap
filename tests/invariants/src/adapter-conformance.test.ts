import { PostgresRgapStore } from '@rgap/store-postgres';
import { SqliteRgapStore } from '@rgap/store-sqlite';
import { describe, expect, it } from 'vitest';
import { runAdapterConformance } from './conformance';

const expectReferenceSnapshot = (
  snapshot: Awaited<ReturnType<typeof runAdapterConformance>>,
) => {
  expect(snapshot.resources).toEqual([
    'acme',
    'acme/finance',
    'acme/finance/payroll',
    'acme/platform',
    'acme/platform/docs',
    'acme/platform/docs/design',
  ]);
  expect(snapshot.grants).toEqual([
    'company',
    'company/team',
    'company/team/agent',
  ]);
  expect(snapshot.decisions).toEqual({
    childReadsDesign: true,
    childWritesDesign: false,
    childReadsPayroll: false,
    parentReadsPayroll: true,
    childReadsAfterRevocation: false,
  });
};

describe('adapter conformance harness', () => {
  it('preserves the reference semantics through SQLite', async () => {
    const store = new SqliteRgapStore({ url: ':memory:' });
    try {
      const snapshot = await runAdapterConformance(store);
      expectReferenceSnapshot(snapshot);
    } finally {
      store.close();
    }
  });

  it.skipIf(!process.env.TEST_POSTGRES_URL)(
    'preserves the reference semantics through PostgreSQL',
    async () => {
      const store = new PostgresRgapStore({
        url: process.env.TEST_POSTGRES_URL!,
      });
      try {
        await store.migrate();
        await store.admin().reset();
        expectReferenceSnapshot(await runAdapterConformance(store));
      } finally {
        await store.close();
      }
    },
  );
});
