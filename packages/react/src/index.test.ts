import { describe, expect, it, vi } from 'vitest';
import { resourceId } from '@rgap/core';
import type { RgapRepository, State } from '@rgap/core';
import { RgapClient } from './index';

const state = (names: string[]): State => ({
  resources: Object.fromEntries(names.map((name) => [name, {
    id: resourceId(name), parentId: null, name, deletedAt: null,
  }])),
  grants: {},
  tokens: {},
  audit: [],
});

describe('RgapClient', () => {
  it('invalidates collection queries and patches returned records after a command', async () => {
    let current = state(['initial']);
    const repository = {
      resources: {
        list: vi.fn(async () => ({ records: Object.values(structuredClone(current.resources)), cursor: null })),
        create: vi.fn(async () => {
          current = state(['initial', 'created']);
          return {
            ...current.resources.created,
            create: vi.fn(),
            move: vi.fn(),
            delete: vi.fn(),
          };
        }),
        get: vi.fn(),
      },
    } as unknown as RgapRepository;
    const client = await RgapClient.connect(repository);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.resources.list();
    listener.mockClear();

    const created = await client.resources.create({ name: 'created' });

    expect(created.id).toBe('created');
    expect(client.getResourceRecords().created.name).toBe('created');
    expect(repository.resources.list).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect((await client.resources.list()).records.map(({ id }) => id)).toEqual(['initial', 'created']);
    expect(repository.resources.list).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached queries explicitly without a streaming repository API', async () => {
    let current = state(['initial']);
    const repository = {
      resources: {
        list: vi.fn(async () => ({ records: Object.values(structuredClone(current.resources)), cursor: null })),
      },
    } as unknown as RgapRepository;
    const client = await RgapClient.connect(repository);
    const listener = vi.fn();
    client.subscribe(listener);
    await client.resources.list();
    listener.mockClear();
    current = state(['external']);

    client.invalidateAll(true);

    expect(listener).toHaveBeenCalledOnce();
    expect((await client.resources.list()).records.map(({ id }) => id)).toEqual(['external']);
  });
});
