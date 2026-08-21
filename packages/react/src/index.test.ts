import { describe, expect, it, vi } from 'vitest';
import type { RgapRepository, State } from '@rgap/core';
import { RgapClient } from './index';

const state = (names: string[]): State => ({
  resources: Object.fromEntries(names.map((name) => [name, {
    id: name, parentId: null, name, deletedAt: null,
  }])),
  grants: {},
  tokens: {},
  audit: [],
});

describe('RgapClient', () => {
  it('loads an initial snapshot and notifies local subscribers after a command', async () => {
    let current = state(['initial']);
    const repository = {
      readState: vi.fn(async () => structuredClone(current)),
      createResource: vi.fn(async () => {
        current = state(['initial', 'created']);
        return current.resources.created;
      }),
    } as unknown as RgapRepository;
    const client = await RgapClient.connect(repository);
    const listener = vi.fn();
    client.subscribe(listener);

    const created = await client.createResource({
      name: 'created', parentId: null,
    });

    expect(created.id).toBe('created');
    expect(client.getSnapshot()).toEqual(current);
    expect(repository.readState).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('refreshes explicitly without a streaming repository API', async () => {
    let current = state(['initial']);
    const repository = { readState: vi.fn(async () => structuredClone(current)) } as unknown as RgapRepository;
    const client = await RgapClient.connect(repository);
    const listener = vi.fn();
    client.subscribe(listener);
    current = state(['external']);

    await client.refresh();

    expect(client.getSnapshot()).toEqual(current);
    expect(listener).toHaveBeenCalledOnce();
  });
});
