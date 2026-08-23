import { describe, expect, it, vi } from 'vitest';
import {
  deleteExecutable,
  getAuthorizedLineage,
  invokeExecutable,
  setExecutable,
  validateBindings,
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
    expect(first.executables[executableId]).toEqual({ resourceId: executableId, runtime: 'one' });
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

  it('validates exact and required binding declarations', () => {
    const declarations = {
      source: { kind: 'document' },
      optional: { kind: 'resource', required: false },
    };
    expect(() => validateBindings(declarations, { source: executableId })).not.toThrow();
    expect(() => validateBindings(declarations, {})).toThrow('source is required');
    expect(() => validateBindings(declarations, { source: executableId, extra: executableId }))
      .toThrow('not declared');
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
    expect(getAuthorizedLineage(input)).toEqual([]);
    expect(getAuthorizedLineage(authorized)).toEqual([grantId('acting')]);
    expect(JSON.stringify(authorized)).toBe(JSON.stringify(input));
  });

  function services(
    state: State,
    implementation: InvokeRuntime,
    over: Partial<InvocationServices> = {},
  ): InvocationServices {
    return {
      getDefinition: async (id) => state.executables[id],
      authorize: vi.fn(async () => ({ lineage: [grantId('acting')] })),
      runtimes: new RuntimeRegistry({ test: implementation }),
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

  it('parses input/output, validates and authorizes bindings, and records safe facts', async () => {
    const inputSchema = parse({ query: 'parsed' });
    const outputSchema = parse({ answer: 'parsed' });
    const implementation = runtime({
      inputSchema,
      outputSchema,
      bindings: {
        source: { kind: 'document' },
        optional: { kind: 'resource', required: false },
      },
      invoke(context) {
        expect(context.input).toEqual({ query: 'parsed' });
        expect(context.bindings).toEqual({
          source: { resourceId: resourceId('read-file'), kind: 'document' },
        });
        return { answer: 'raw' };
      },
    });
    const configured = prepared(implementation);
    await expect(collect(invokeExecutable(configured, executableId, {
      input: { query: 'raw' },
      bindings: { source: resourceId('read-file') },
    }))).resolves.toEqual([
      { type: 'data', value: { answer: 'parsed' } },
      { type: 'done' },
    ]);
    expect(inputSchema.parse).toHaveBeenCalledWith({ query: 'raw' });
    expect(outputSchema.parse).toHaveBeenCalledWith({ answer: 'raw' });
    expect(configured.authorize).toHaveBeenCalledTimes(2);
    expect(configured.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: executableId,
      runtime: 'test',
      grantLineage: [grantId('acting')],
      bindings: { source: resourceId('read-file') },
      result: 'done',
    }));
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
