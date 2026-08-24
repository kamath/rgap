import { SqliteRgapStore } from '@rgap/sqlite';
import { describe, expect, it } from 'vitest';
import { runAdapterConformance } from './conformance';

describe('adapter conformance harness', () => {
  it('preserves the reference semantics through SQLite', async () => {
    const store = new SqliteRgapStore({ url: ':memory:' });
    try {
      const snapshot = await runAdapterConformance(store);

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
    } finally {
      store.close();
    }
  });
});
