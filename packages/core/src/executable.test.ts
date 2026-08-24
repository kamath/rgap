import { describe, expect, it, vi } from 'vitest';
import {
  deleteExecutable,
  getAuthorizedLineage,
  invokeExecutable,
  setExecutable,
  withAuthorizedBindings,
  withAuthorizedLineage,
  type InvocationServices,
} from './executable';
import { grantId, resourceId, type State } from './domain';
import { fixture } from './fixture';
import { RuntimeRegistry, type InvokeRuntime } from './runtime';

const at = '2026-08-22T00:00:00.000Z';
const executableId = resourceId('search-files');
const parse = <T>(value: T) => ({ parse: vi.fn(() => value) });
const runtime = (
  over: Partial<InvokeRuntime> = {},
): InvokeRuntime => ({
  inputSchema: null,
  outputSchema: null,
  invoke: () => undefined,
  ...over,
});

const collect = async <T>(values: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

describe('executable associations', () => {
  it('sets, replaces, and deletes a registered runtime association', () => {
    const runtimes = new RuntimeRegistry({ one: runtime(), two: runtime() });
    const first = setExecutable(fixture(), executableId, { runtime: ' one ' }, at, runtimes);
    expect(first.executables[executableId]).toEqual({
      resourceId: executableId,
      runtime: 'one',
      bind: {},
    });
    expect(first.audit[0].action).toBe('executable.set');

    const second = setExecutable(first, executableId, { runtime: 'two' }, at, runtimes);
    expect(second.executables[executableId].runtime).toBe('two');
    const deleted = deleteExecutable(second, executableId, at);
    expect(deleted.executables[executableId]).toBeUndefined();
    expect(deleted.audit[0].action).toBe('executable.delete');
    expect(() => deleteExecutable(deleted, executableId, at)).toThrow('does not exist');
  });

  it('requires a live resource, a name, and a registered runtime', () => {
    const runtimes = new RuntimeRegistry();
    expect(() => setExecutable(fixture(), resourceId('missing'), { runtime: 'x' }, at, runtimes))
      .toThrow('Resource does not exist');
    expect(() => setExecutable(fixture(), executableId, { runtime: ' ' }, at, runtimes))
      .toThrow('Runtime name');
    expect(() => setExecutable(fixture(), executableId, { runtime: 'x' }, at, runtimes))
      .toThrow('not registered');
  });

  it('seals live bindings with administrative or recorded grant provenance', () => {
    const runtimes = new RuntimeRegistry({ test: runtime() });
    const admin = setExecutable(fixture(), executableId, {
      runtime: 'test',
      bind: { source: resourceId('read-file') },
    }, at, runtimes);
    expect(admin.executables[executableId].bind.source).toEqual({
      resourceId: resourceId('read-file'),
      grantLineage: null,
    });

    const authorized = withAuthorizedBindings({
      runtime: 'test',
      bind: { source: resourceId('read-file') },
    }, { source: [grantId('researcher'), grantId('coordinator')] });
    const token = setExecutable(fixture(), executableId, authorized, at, runtimes);
    expect(token.executables[executableId].bind.source.grantLineage).toEqual([
      grantId('researcher'),
      grantId('coordinator'),
    ]);

    expect(() => setExecutable(fixture(), executableId, {
      runtime: 'test',
      bind: { missing: resourceId('missing') },
    }, at, runtimes)).toThrow('does not exist');
    expect(() => setExecutable(fixture(), executableId, {
      runtime: 'test',
      bind: { ['__proto__']: resourceId('read-file') },
    }, at, runtimes)).toThrow('reserved');
    expect(() => setExecutable(
      fixture(),
      executableId,
      withAuthorizedBindings({
        runtime: 'test',
        bind: { source: resourceId('read-file') },
      }, {}),
      at,
      runtimes,
    )).toThrow('was not authorized');
  });
});

describe('runtime registry and invocation', () => {
  it('supports heterogeneous object and map registrations', () => {
    const echo: InvokeRuntime<{ value: string }, string> = {
      inputSchema: parse({ value: 'typed' }),
      outputSchema: parse('typed-output'),
      invoke: ({ input }) => input.value,
    };
    const count: InvokeRuntime<number, number> = {
      inputSchema: parse(2),
      outputSchema: parse(4),
      invoke: ({ input }) => input * 2,
    };
    const object = new RuntimeRegistry({ echo, count });
    const map = new RuntimeRegistry(new Map([['echo', echo]]));
    expect(object.has('echo')).toBe(true);
    expect(object.get('count')).toBe(count);
    expect(map.get('echo')).toBe(echo);
    expect(() => object.get('missing')).toThrow('not registered');
  });

  it('carries authorized lineage outside the JSON shape', () => {
    const input = { input: { query: 'x' } };
    const authorized = withAuthorizedLineage(input, [grantId('acting')]);
    expect(getAuthorizedLineage(input)).toBeNull();
    expect(getAuthorizedLineage(authorized)).toEqual([grantId('acting')]);
    expect(JSON.stringify(authorized)).toBe(JSON.stringify(input));
  });

  function services(
    state: State,
    implementation: InvokeRuntime,
    over: Partial<InvocationServices> = {},
  ): InvocationServices {
    let invocation = 0;
    return {
      getDefinition: async (id) => state.executables[id],
      authorize: vi.fn(async (_id, _permission, lineage) => ({ lineage: lineage ?? [] })),
      runtimes: new RuntimeRegistry({ test: implementation }),
      createInvocationId: () => `invocation-${++invocation}`,
      recordInvocation: vi.fn(async () => undefined),
      ...over,
    };
  }

  const prepared = (implementation: InvokeRuntime) => {
    const state = setExecutable(
      fixture(),
      executableId,
      { runtime: 'test' },
      at,
      new RuntimeRegistry({ test: implementation }),
    );
    return services(state, implementation);
  };

  it('inserts sealed input, authorizes bindings, and records safe facts', async () => {
    const inputSchema = parse({ query: 'parsed' });
    const outputSchema = parse({ answer: 'parsed' });
    const implementation = runtime({
      inputSchema,
      outputSchema,
      invoke(context) {
        expect(context.input).toEqual({ query: 'parsed' });
        return { answer: 'raw' };
      },
    });
    const state = setExecutable(
      fixture(),
      executableId,
      { runtime: 'test', bind: { source: resourceId('read-file') } },
      at,
      new RuntimeRegistry({ test: implementation }),
    );
    const configured = services(state, implementation);
    await expect(collect(invokeExecutable(configured, executableId, {
      input: { query: 'raw' },
    }))).resolves.toEqual([
      { type: 'data', value: { answer: 'parsed' } },
      { type: 'done' },
    ]);
    expect(inputSchema.parse).toHaveBeenCalledWith(expect.objectContaining({
      query: 'raw',
      source: resourceId('read-file'),
    }));
    expect(outputSchema.parse).toHaveBeenCalledWith({ answer: 'raw' });
    expect(configured.authorize).toHaveBeenCalledTimes(2);
    expect(configured.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      id: 'invocation-1',
      parentInvocationId: null,
      resourceId: executableId,
      runtime: 'test',
      grantLineage: [],
      bindings: { source: resourceId('read-file') },
      result: 'done',
    }));

    await expect(collect(invokeExecutable(configured, executableId, {
      input: { query: 'raw', source: 'override' },
    }))).rejects.toThrow('cannot override sealed field');
    for (const invalid of [null, 'not-an-object', []]) {
      await expect(collect(invokeExecutable(configured, executableId, {
        input: invalid,
      }))).rejects.toThrow('must be an object');
    }
  });

  it('composes nested invocations by resource ID and records the call chain', async () => {
    const childId = resourceId('read-file');
    const child = runtime({ invoke: () => ({ login: 'alice' }) });
    const parent = runtime({
      async invoke({ input, invoke }) {
        const bound = input as { profile: string };
        const profile = await invoke.one<{ login: string }>(
          bound.profile,
          { input: null },
        );
        return `GitHub user: ${profile.login}`;
      },
    });
    const runtimes = new RuntimeRegistry({ parent, child });
    let state = setExecutable(fixture(), childId, { runtime: 'child' }, at, runtimes);
    state = setExecutable(state, executableId, {
      runtime: 'parent',
      bind: { profile: childId },
    }, at, runtimes);
    let invocation = 0;
    const configured = services(state, parent, {
      runtimes,
      createInvocationId: () => `nested-${++invocation}`,
    });

    await expect(collect(invokeExecutable(
      configured,
      executableId,
      { input: {} },
    ))).resolves.toEqual([
      { type: 'data', value: 'GitHub user: alice' },
      { type: 'done' },
    ]);
    expect(configured.recordInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'nested-1',
        parentInvocationId: null,
        resourceId: executableId,
      }),
    );
    expect(configured.recordInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'nested-2',
        parentInvocationId: 'nested-1',
        resourceId: childId,
      }),
    );
  });

  it('rejects active nested cycles and invalid one-value results', async () => {
    const childId = resourceId('read-file');
    const cycle = runtime({
      async invoke({ invoke }) {
        return invoke.one(executableId, { input: null });
      },
    });
    const parent = runtime({
      async invoke({ input, invoke }) {
        return invoke.one((input as { child: string }).child, { input: null });
      },
    });
    const runtimes = new RuntimeRegistry({ parent, cycle });
    let state = setExecutable(fixture(), childId, { runtime: 'cycle' }, at, runtimes);
    state = setExecutable(state, executableId, {
      runtime: 'parent',
      bind: { child: childId },
    }, at, runtimes);
    const configured = services(state, parent, { runtimes });
    await expect(collect(invokeExecutable(
      configured,
      executableId,
      { input: {} },
    ))).rejects.toMatchObject({ code: 'invocation_cycle' });

    const emptyChild = runtime();
    const noValueRuntimes = new RuntimeRegistry({ parent, cycle: emptyChild });
    state = setExecutable(fixture(), childId, { runtime: 'cycle' }, at, noValueRuntimes);
    state = setExecutable(state, executableId, {
      runtime: 'parent',
      bind: { child: childId },
    }, at, noValueRuntimes);
    await expect(collect(invokeExecutable(
      services(state, parent, { runtimes: noValueRuntimes }),
      executableId,
      { input: {} },
    ))).rejects.toMatchObject({ code: 'invalid_nested_result' });

    const multiChild = runtime({
      async *invoke() {
        yield 'one';
        yield 'two';
      },
    });
    const multiRuntimes = new RuntimeRegistry({ parent, cycle: multiChild });
    state = setExecutable(fixture(), childId, { runtime: 'cycle' }, at, multiRuntimes);
    state = setExecutable(state, executableId, {
      runtime: 'parent',
      bind: { child: childId },
    }, at, multiRuntimes);
    await expect(collect(invokeExecutable(
      services(state, parent, { runtimes: multiRuntimes }),
      executableId,
      { input: {} },
    ))).rejects.toMatchObject({ code: 'invalid_nested_result' });
  });

  it('rejects nested invocation deeper than 32 frames', async () => {
    const chain = runtime({
      async invoke({ input, invoke }) {
        const next = (input as { next?: string }).next;
        return next ? invoke.one(next, { input: {} }) : 'done';
      },
    });
    const runtimes = new RuntimeRegistry({ chain });
    let state = fixture();
    const ids = Array.from({ length: 33 }, (_, index) => resourceId(`chain-${index}`));
    ids.forEach((id) => {
      state.resources[id] = {
        id,
        parentId: null,
        name: id,
        deletedAt: null,
      };
    });
    ids.forEach((id, index) => {
      state = setExecutable(state, id, {
        runtime: 'chain',
        bind: index === ids.length - 1 ? undefined : { next: ids[index + 1] },
      }, at, runtimes);
    });

    await expect(collect(invokeExecutable(
      services(state, chain, { runtimes }),
      ids[0],
      { input: {} },
    ))).rejects.toMatchObject({ code: 'invocation_depth' });
  });

  it('normalizes promise, async iterable, null, and undefined results', async () => {
    const invoke = (implementation: InvokeRuntime) =>
      collect(invokeExecutable(prepared(implementation), executableId, { input: null }));
    await expect(invoke(runtime({ invoke: async () => 'promise' }))).resolves.toEqual([
      { type: 'data', value: 'promise' }, { type: 'done' },
    ]);
    await expect(invoke(runtime({ invoke: () => null }))).resolves.toEqual([
      { type: 'data', value: null }, { type: 'done' },
    ]);
    await expect(invoke(runtime({
      async *invoke() {
        yield 'one';
        yield undefined;
        yield 'two';
      },
    }))).resolves.toEqual([
      { type: 'data', value: 'one' },
      { type: 'data', value: 'two' },
      { type: 'done' },
    ]);
    await expect(invoke(runtime({
      outputSchema: parse('parsed-stream'),
      async *invoke() {
        yield 'raw-stream';
      },
    }))).resolves.toEqual([
      { type: 'data', value: 'parsed-stream' },
      { type: 'done' },
    ]);
    await expect(invoke(runtime())).resolves.toEqual([{ type: 'done' }]);
  });

  it('reports missing definitions and parse/runtime errors', async () => {
    await expect(collect(invokeExecutable(
      services(fixture(), runtime()),
      executableId,
      { input: null },
    ))).rejects.toThrow('does not exist');

    const badInput = runtime({ inputSchema: { parse: () => { throw new Error('bad input'); } } });
    await expect(collect(invokeExecutable(prepared(badInput), executableId, { input: null })))
      .rejects.toThrow('bad input');

    for (const implementation of [
      runtime({ invoke: () => { throw new Error('thrown'); } }),
      runtime({ invoke: () => Promise.reject(new Error('rejected')) }),
      runtime({ outputSchema: { parse: () => { throw new Error('bad output'); } }, invoke: () => 'raw' }),
    ]) {
      const configured = prepared(implementation);
      await expect(collect(invokeExecutable(configured, executableId, { input: null }))).rejects.toThrow();
      expect(configured.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({ result: 'error' }));
    }
  });

  it('propagates pre-abort, later abort, and early iterator return', async () => {
    const before = new AbortController();
    before.abort('before');
    const preRuntime = runtime({
      invoke({ signal }) {
        expect(signal.aborted).toBe(true);
        expect(signal.reason).toBe('before');
      },
    });
    const pre = prepared(preRuntime);
    await collect(invokeExecutable(pre, executableId, { input: null, signal: before.signal }));
    expect(pre.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({ result: 'cancelled' }));

    const later = new AbortController();
    const laterRuntime = runtime({ invoke: ({ signal }) => {
      later.abort('later');
      expect(signal.aborted).toBe(true);
    } });
    const during = prepared(laterRuntime);
    await collect(invokeExecutable(during, executableId, { input: null, signal: later.signal }));
    expect(during.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({ result: 'cancelled' }));

    let runtimeSignal: AbortSignal | undefined;
    const early = prepared(runtime({
      async *invoke({ signal }) {
        runtimeSignal = signal;
        yield 'one';
        yield 'two';
      },
    }));
    for await (const event of invokeExecutable(early, executableId, { input: null })) {
      expect(event.type).toBe('data');
      break;
    }
    expect(runtimeSignal?.aborted).toBe(true);
    expect(early.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({ result: 'cancelled' }));
  });

  it('records a runtime failure after abort as cancelled', async () => {
    const controller = new AbortController();
    const configured = prepared(runtime({
      invoke() {
        controller.abort();
        throw new Error('cancelled runtime');
      },
    }));
    await expect(collect(invokeExecutable(configured, executableId, {
      input: null,
      signal: controller.signal,
    }))).rejects.toThrow('cancelled runtime');
    expect(configured.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({ result: 'cancelled' }));
  });
});
