import { describe, expect, it, vi } from 'vitest';
import {
  assertJsonSchema,
  deleteExecutable,
  effectiveExecutionLimits,
  getAuthorizedLineage,
  invokeExecutable,
  publishExecutable,
  validateBindings,
  validateExecutableRevision,
  validateRuntimeProgram,
  withAuthorizedLineage,
  type InvocationServices,
  type PublishExecutableInput,
} from './executable';
import { executableRevisionId, grantId, resourceId, type State } from './domain';
import { fixture } from './fixture';
import { RuntimeRegistry, type InvokeRuntime, type JsonSchemaValidator } from './runtime';

const at = '2026-08-22T00:00:00.000Z';
const executableId = resourceId('search-files');
const revisionId = executableRevisionId('revision-one');
const publication: PublishExecutableInput = {
  runtime: 'test',
  program: { operation: 'search' },
  inputSchema: true,
  outputSchema: true,
  bindingSchema: {
    source: { kind: 'document' },
    destination: { kind: 'collection', required: false },
  },
  limits: { timeoutMs: 20, network: { allowedOrigins: ['https://api.example'] } },
};

const validator: JsonSchemaValidator = {
  validate: (schema) => schema === false
    ? { valid: false, errors: ['false schema'] }
    : { valid: true },
};

const collect = async <T>(values: AsyncIterable<T>) => {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
};

describe('executable domain rules', () => {
  it('publishes immutable revisions, selects the latest, and soft-deletes definitions', () => {
    const validate = vi.fn();
    const first = publishExecutable(fixture(), executableId, publication, revisionId, at, validate);

    expect(first.executables[executableId]).toEqual({
      resourceId: executableId, activeRevisionId: revisionId, deletedAt: null,
    });
    expect(first.executableRevisions[revisionId].program).not.toBe(publication.program);
    expect(first.audit[0].action).toBe('executable.publish');
    expect(validate).toHaveBeenCalledWith('test', publication.program);

    const deleted = deleteExecutable(first, executableId, at);
    expect(deleted.executables[executableId].activeRevisionId).toBe(null);
    expect(deleted.executables[executableId].deletedAt).toBe(at);
    expect(deleted.executableRevisions[revisionId]).toEqual(first.executableRevisions[revisionId]);
    expect(deleted.audit[0].action).toBe('executable.delete');
    expect(() => deleteExecutable(deleted, executableId, at)).toThrow('does not exist');
    expect(() => publishExecutable(deleted, executableId, publication, executableRevisionId('two'), at, validate))
      .toThrow('deleted executable');
  });

  it('rejects invalid resources, duplicate revisions, programs, schemas, slots, and limits', () => {
    expect(() => publishExecutable(fixture(), resourceId('missing'), publication, revisionId, at, vi.fn()))
      .toThrow('Resource does not exist');
    const published = publishExecutable(fixture(), executableId, publication, revisionId, at, vi.fn());
    expect(() => publishExecutable(published, executableId, publication, revisionId, at, vi.fn()))
      .toThrow('already exists');
    expect(() => publishExecutable(
      fixture(), executableId, publication, revisionId, at,
      () => { throw new Error('bad program'); },
    )).toThrow('bad program');

    const invalid = (over: Partial<PublishExecutableInput>) =>
      () => validateExecutableRevision({ ...publication, ...over });
    expect(invalid({ runtime: ' ' })).toThrow('Runtime name');
    for (const limits of [
      { timeoutMs: 0 }, { memoryBytes: 1.5 }, { outputBytes: -1 }, { concurrency: Number.MAX_VALUE },
    ]) expect(invalid({ limits })).toThrow('positive integer');
    expect(invalid({ limits: { network: { allowedOrigins: null as never } } }))
      .toThrow('must be an array');
    expect(invalid({ bindingSchema: { ' ': { kind: 'resource' } } }))
      .toThrow('Binding names');
    expect(invalid({ bindingSchema: { bad: { kind: ' ' } } }))
      .toThrow('requires a kind');
    expect(invalid({ bindingSchema: { bad: null as never } }))
      .toThrow('requires a kind');
    expect(invalid({ bindingSchema: { bad: { kind: 1 as never } } }))
      .toThrow('requires a kind');
    expect(invalid({ bindingSchema: { bad: { kind: 'resource', extra: true } as never } }))
      .toThrow('unknown property');
    expect(invalid({ bindingSchema: { bad: { kind: 'resource', required: 'yes' as never } } }))
      .toThrow('invalid required flag');
  });

  it('validates binding maps, JSON values, and runtime ceilings', () => {
    expect(() => validateBindings(publication.bindingSchema, { source: executableId })).not.toThrow();
    expect(() => validateBindings(publication.bindingSchema, {})).toThrow('source is required');
    expect(() => validateBindings(publication.bindingSchema, { source: executableId, extra: executableId }))
      .toThrow('not declared');
    expect(() => assertJsonSchema(validator, false, {}, 'bad value')).toThrow('bad value: false schema');
    expect(() => assertJsonSchema(validator, true, {}, 'good value')).not.toThrow();

    expect(effectiveExecutionLimits(
      {
        timeoutMs: 100, memoryBytes: 200, outputBytes: 300, concurrency: 4,
        network: { allowedOrigins: ['a', 'b'] },
      },
      { timeoutMs: 50, network: { allowedOrigins: ['a'] } },
    )).toEqual({
      timeoutMs: 50, memoryBytes: 200, outputBytes: 300, concurrency: 4,
      network: { allowedOrigins: ['a'] },
    });
    expect(effectiveExecutionLimits({}, {})).toEqual({
      timeoutMs: undefined, memoryBytes: undefined, outputBytes: undefined, concurrency: undefined,
    });
    expect(effectiveExecutionLimits(
      { network: { allowedOrigins: ['host-only'] } },
      {},
    ).network).toEqual({ allowedOrigins: ['host-only'] });
    expect(effectiveExecutionLimits(
      {},
      { network: { allowedOrigins: ['revision-only'] } },
    ).network).toEqual({ allowedOrigins: ['revision-only'] });
    expect(() => effectiveExecutionLimits({ timeoutMs: 10 }, { timeoutMs: 11 })).toThrow('ceiling');
    expect(() => effectiveExecutionLimits(
      { network: { allowedOrigins: ['a'] } },
      { network: { allowedOrigins: ['b'] } },
    )).toThrow('origins');
  });

});

describe('invocation orchestration', () => {
  const preparedState = () =>
    publishExecutable(fixture(), executableId, publication, revisionId, at, vi.fn());

  it('uses immutable object or map runtime configuration and refuses unknown names', () => {
    const runtime: InvokeRuntime = { validate() {}, invoke() { return undefined; } };
    const objectRegistry = new RuntimeRegistry({ test: runtime });
    const mapRegistry = new RuntimeRegistry(new Map([['test', runtime]]));
    expect(objectRegistry.has('test')).toBe(true);
    expect(objectRegistry.get('test')).toBe(runtime);
    expect(mapRegistry.get('test')).toBe(runtime);
    expect(validateRuntimeProgram(objectRegistry, 'test', {})).toBeUndefined();
    expect(() => objectRegistry.get('missing')).toThrow('not registered');
  });

  it('carries authorized lineage outside the JSON invocation shape', () => {
    const input = { input: { query: 'x' } };
    const authorized = withAuthorizedLineage(input, [grantId('acting')]);

    expect(getAuthorizedLineage(input)).toEqual([]);
    expect(getAuthorizedLineage(authorized)).toEqual([grantId('acting')]);
    expect(JSON.stringify(authorized)).toBe(JSON.stringify(input));
  });

  function services(
    state: State,
    runtime: InvokeRuntime,
    over: Partial<InvocationServices> = {},
  ): InvocationServices {
    return {
      getDefinition: async (id) => state.executables[id],
      getRevision: async (id) => state.executableRevisions[id],
      authorize: vi.fn(async () => ({ lineage: [grantId('acting')] })),
      runtimes: new RuntimeRegistry({ test: runtime }),
      validator,
      runtimeLimits: () => ({
        timeoutMs: 100,
        network: { allowedOrigins: ['https://api.example'] },
      }),
      recordInvocation: vi.fn(async () => undefined),
      ...over,
    };
  }

  it('authorizes bindings and gives runtimes only opaque resource identities and kinds', async () => {
    const order: string[] = [];
    const runtime: InvokeRuntime = {
      validate(program): asserts program is unknown {
        void program;
        order.push('validate');
      },
      async invoke(context) {
        order.push('invoke');
        expect(context.bindings).toEqual({
          source: { resourceId: resourceId('read-file'), kind: 'document' },
          destination: { resourceId: resourceId('drive'), kind: 'collection' },
        });
        return { ok: true };
      },
    };
    const state = preparedState();
    const base = services(state, runtime);
    base.authorize = vi.fn(async (_id, permission) => {
      order.push(`authorize:${permission}`);
      return { lineage: [grantId('acting')] };
    });
    const events = await collect(invokeExecutable(base, executableId, {
      input: { query: 'x' },
      bindings: { source: resourceId('read-file'), destination: resourceId('drive') },
    }));

    expect(events).toEqual([{ type: 'data', value: { ok: true } }, { type: 'done' }]);
    expect(order.slice(0, 4)).toEqual([
      'authorize:invoke', 'authorize:invoke', 'authorize:invoke', 'validate',
    ]);
    expect(base.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: executableId,
      revisionId,
      runtime: 'test',
      grantLineage: [grantId('acting')],
      bindings: { source: resourceId('read-file'), destination: resourceId('drive') },
      result: 'done',
    }));
  });

  it('normalizes sync, promise, async iterable, and undefined runtime results', async () => {
    const state = preparedState();
    const invoke = (runtime: InvokeRuntime) => collect(invokeExecutable(
      services(state, runtime),
      executableId,
      { input: {}, bindings: { source: resourceId('drive') } },
    ));

    await expect(invoke({ validate() {}, invoke: () => 'sync' })).resolves.toEqual([
      { type: 'data', value: 'sync' },
      { type: 'done' },
    ]);
    await expect(invoke({ validate() {}, invoke: async () => 'promise' })).resolves.toEqual([
      { type: 'data', value: 'promise' },
      { type: 'done' },
    ]);
    await expect(invoke({ validate() {}, invoke: () => null })).resolves.toEqual([
      { type: 'data', value: null },
      { type: 'done' },
    ]);
    await expect(invoke({
      validate() {},
      async *invoke() {
        yield 'first';
        yield 'second';
      },
    })).resolves.toEqual([
      { type: 'data', value: 'first' },
      { type: 'data', value: 'second' },
      { type: 'done' },
    ]);
    await expect(invoke({ validate() {}, invoke: () => undefined })).resolves.toEqual([
      { type: 'done' },
    ]);
  });

  it('supports heterogeneous typed runtimes and narrows their program and input', () => {
    type EchoProgram = { prefix: string };
    const echo: InvokeRuntime<EchoProgram, { value: string }, string> = {
      validate(program): asserts program is EchoProgram {
        if (!program || typeof program !== 'object' || !('prefix' in program)) throw new Error('invalid');
      },
      invoke({ revision, input }) {
        return `${revision.program.prefix}${input.value}`;
      },
    };
    const count: InvokeRuntime<{ multiplier: number }, number, number> = {
      validate(program): asserts program is { multiplier: number } {
        if (!program || typeof program !== 'object' || !('multiplier' in program)) throw new Error('invalid');
      },
      invoke({ revision, input }) {
        return revision.program.multiplier * input;
      },
    };
    const registry = new RuntimeRegistry({ echo, count });

    expect(registry.get('echo')).toBe(echo);
    expect(registry.get('count')).toBe(count);
  });

  it('skips nullable schemas and validates every emitted output item', async () => {
    const state = preparedState();
    state.executableRevisions[revisionId].inputSchema = null;
    state.executableRevisions[revisionId].outputSchema = null;
    const skipped = vi.fn(() => ({ valid: false as const, errors: ['must not run'] }));
    await expect(collect(invokeExecutable(services(state, {
      validate() {},
      async *invoke() {
        yield 'unchecked';
      },
    }, { validator: { validate: skipped } }), executableId, {
      input: undefined,
      bindings: { source: resourceId('drive') },
    }))).resolves.toEqual([{ type: 'data', value: 'unchecked' }, { type: 'done' }]);
    expect(skipped).not.toHaveBeenCalled();

    state.executableRevisions[revisionId].inputSchema = true;
    state.executableRevisions[revisionId].outputSchema = true;
    const validate = vi.fn((
      _schema: Parameters<JsonSchemaValidator['validate']>[0],
      _value: unknown,
    ) => ({ valid: true as const }));
    await collect(invokeExecutable(services(state, {
      validate() {},
      async *invoke() {
        yield 1;
        yield undefined;
        yield 2;
      },
    }, { validator: { validate } }), executableId, {
      input: {},
      bindings: { source: resourceId('drive') },
    }));
    expect(validate).toHaveBeenCalledTimes(3);
    expect(validate.mock.calls.slice(1).map((call) => call[1])).toEqual([1, 2]);
  });

  it('records thrown and rejected runtime failures as errors', async () => {
    for (const runtime of [
      { validate() {}, invoke() { throw new Error('thrown'); } },
      { validate() {}, invoke() { return Promise.reject(new Error('rejected')); } },
    ] satisfies InvokeRuntime[]) {
      const configured = services(preparedState(), runtime);
      await expect(collect(invokeExecutable(configured, executableId, {
        input: {},
        bindings: { source: resourceId('drive') },
      }))).rejects.toThrow();
      expect(configured.recordInvocation)
        .toHaveBeenCalledWith(expect.objectContaining({ result: 'error' }));
    }
  });

  it('rejects missing definitions, revisions, invalid inputs and outputs, and unknown runtimes', async () => {
    const runtime: InvokeRuntime = {
      validate() {},
      invoke() { return 'bad'; },
    };
    const empty = services(fixture(), runtime);
    await expect(collect(invokeExecutable(empty, executableId, { input: {} }))).rejects.toThrow('does not exist');

    const state = preparedState();
    state.executables[executableId].activeRevisionId = null;
    await expect(collect(invokeExecutable(services(state, runtime), executableId, { input: {} })))
      .rejects.toThrow('no active revision');
    state.executables[executableId].activeRevisionId = revisionId;
    await expect(collect(invokeExecutable(services(state, runtime), executableId, {
      input: {}, revisionId: executableRevisionId('missing'),
    }))).rejects.toThrow('does not exist on this resource');

    const invalidInput = services(state, runtime, { validator: { validate: () => ({ valid: false, errors: ['bad'] }) } });
    await expect(collect(invokeExecutable(invalidInput, executableId, { input: {} })))
      .rejects.toThrow('Invocation input');
    const unknownRuntime = services(state, runtime, { runtimes: new RuntimeRegistry() });
    await expect(collect(invokeExecutable(unknownRuntime, executableId, {
      input: {}, bindings: { source: resourceId('drive') },
    }))).rejects.toThrow('not registered');

    const outputValidator: JsonSchemaValidator = {
      validate: (schema) => schema === publication.inputSchema
        ? { valid: true }
        : { valid: false, errors: ['bad output'] },
    };
    // Distinct object schemas make input and output validation distinguishable.
    state.executableRevisions[revisionId].inputSchema = {};
    state.executableRevisions[revisionId].outputSchema = { type: 'object' };
    const selective: JsonSchemaValidator = {
      validate: (schema) => schema === state.executableRevisions[revisionId].inputSchema
        ? { valid: true }
        : { valid: false, errors: ['bad output'] },
    };
    void outputValidator;
    await expect(collect(invokeExecutable(services(state, runtime, { validator: selective }), executableId, {
      input: {}, bindings: { source: resourceId('drive') },
    }))).rejects.toThrow('Runtime output');

    state.executableRevisions[revisionId].outputSchema = false;
    await expect(collect(invokeExecutable(services(state, runtime), executableId, {
      input: {}, bindings: { source: resourceId('drive') },
    }))).rejects.toThrow('Runtime output');

    state.executableRevisions[revisionId].outputSchema = null;
    await expect(collect(invokeExecutable(services(state, runtime, { validator: selective }), executableId, {
      input: {}, bindings: { source: resourceId('drive') },
    }))).resolves.toEqual([{ type: 'data', value: 'bad' }, { type: 'done' }]);
  });

  it('propagates cancellation and records downstream early return without recording values', async () => {
    let runtimeSignal: AbortSignal | undefined;
    const runtime: InvokeRuntime = {
      validate() {},
      async *invoke(context) {
        runtimeSignal = context.signal;
        yield 'first';
        yield 'second';
      },
    };
    const configured = services(preparedState(), runtime);
    const events = invokeExecutable(configured, executableId, {
      input: {}, bindings: { source: resourceId('drive') },
    });
    for await (const event of events) {
      expect(event.type).toBe('data');
      break;
    }
    expect(runtimeSignal?.aborted).toBe(true);
    expect(configured.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({ result: 'cancelled' }));
    expect(JSON.stringify(vi.mocked(configured.recordInvocation).mock.calls)).not.toContain('first');
  });

  it('starts cancelled for an aborted signal and observes later signal cancellation', async () => {
    const state = publishExecutable(
      fixture(),
      executableId,
      { ...publication, bindingSchema: {} },
      revisionId,
      at,
      vi.fn(),
    );
    const alreadyAborted = new AbortController();
    alreadyAborted.abort('before invocation');
    const preAbortedRuntime: InvokeRuntime = {
      validate() {},
      invoke(context) {
        expect(context.signal.aborted).toBe(true);
        expect(context.signal.reason).toBe('before invocation');
      },
    };
    const preAbortedServices = services(state, preAbortedRuntime);

    await expect(collect(invokeExecutable(preAbortedServices, executableId, {
      input: {},
      signal: alreadyAborted.signal,
    }))).resolves.toEqual([{ type: 'done' }]);
    expect(preAbortedServices.recordInvocation)
      .toHaveBeenCalledWith(expect.objectContaining({ bindings: {}, result: 'cancelled' }));

    const later = new AbortController();
    const laterRuntime: InvokeRuntime = {
      validate() {},
      invoke(context) {
        later.abort('during invocation');
        expect(context.signal.aborted).toBe(true);
        expect(context.signal.reason).toBe('during invocation');
      },
    };
    const laterServices = services(state, laterRuntime);

    await collect(invokeExecutable(laterServices, executableId, {
      input: {},
      signal: later.signal,
    }));
    expect(laterServices.recordInvocation)
      .toHaveBeenCalledWith(expect.objectContaining({ bindings: {}, result: 'cancelled' }));

    const failedAfterAbort = new AbortController();
    const cancelledFailure = services(state, {
      validate() {},
      invoke() {
        failedAfterAbort.abort('cancel before failure');
        throw new Error('cancelled runtime');
      },
    });
    await expect(collect(invokeExecutable(cancelledFailure, executableId, {
      input: {},
      signal: failedAfterAbort.signal,
    }))).rejects.toThrow('cancelled runtime');
    expect(cancelledFailure.recordInvocation)
      .toHaveBeenCalledWith(expect.objectContaining({ result: 'cancelled' }));
  });
});
