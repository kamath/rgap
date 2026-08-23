import {
  RgapError,
  isLive,
  type BindingSlot,
  type ExecutableDefinition,
  type GrantId,
  type Permission,
  type ResourceId,
  type State,
} from './domain';
import {
  RuntimeRegistry,
  type InvocationEvent,
  type InvokeRuntime,
  type RuntimeBinding,
} from './runtime';

export type SetExecutableInput = { runtime: string };
export type InvokeInput = {
  input: unknown;
  bindings?: Record<string, ResourceId>;
  signal?: AbortSignal;
};

const authorizedLineage = Symbol('authorized invocation lineage');
type AuthorizedInvokeInput = InvokeInput & { [authorizedLineage]?: GrantId[] };

/** Internal command-plane context attached by the bearer guard after it authorizes invocation. */
export function withAuthorizedLineage(input: InvokeInput, lineage: GrantId[]): InvokeInput {
  const authorized = { ...input } as AuthorizedInvokeInput;
  Object.defineProperty(authorized, authorizedLineage, { value: [...lineage] });
  return authorized;
}

/** Returns command-plane context without exposing it on the JSON invocation shape. */
export function getAuthorizedLineage(input: InvokeInput) {
  return [...((input as AuthorizedInvokeInput)[authorizedLineage] ?? [])];
}

const cloned = <T>(value: T): T => structuredClone(value);

/** Atomically creates or replaces a resource-to-runtime association. */
export function setExecutable(
  state: State,
  resourceId: ResourceId,
  input: SetExecutableInput,
  at: string,
  runtimes: RuntimeRegistry,
) {
  if (!isLive(state.resources[resourceId])) {
    throw new RgapError('missing_resource', 'Resource does not exist.');
  }
  const runtime = input.runtime.trim();
  if (!runtime) throw new RgapError('invalid_runtime', 'Runtime name is required.');
  runtimes.get(runtime);
  const next = cloned(state);
  next.executables[resourceId] = { resourceId, runtime };
  next.audit.unshift({
    id: `${at}:executable.set:${next.audit.length}`,
    at,
    action: 'executable.set',
    target: resourceId,
    result: 'recorded',
    detail: `Associated runtime ${runtime}.`,
  });
  return next;
}

/** Deletes the association; setting it again later creates a new current association. */
export function deleteExecutable(state: State, resourceId: ResourceId, at: string) {
  if (!state.executables[resourceId]) {
    throw new RgapError('missing_executable', 'Executable does not exist.');
  }
  const next = cloned(state);
  delete next.executables[resourceId];
  next.audit.unshift({
    id: `${at}:executable.delete:${next.audit.length}`,
    at,
    action: 'executable.delete',
    target: resourceId,
    result: 'recorded',
    detail: 'Deleted executable definition.',
  });
  return next;
}

/** Validates exact slot names and required slots. */
export function validateBindings(
  declarations: Readonly<Record<string, BindingSlot>>,
  supplied: Readonly<Record<string, ResourceId>>,
) {
  for (const name of Object.keys(supplied)) {
    if (!declarations[name]) throw new RgapError('invalid_bindings', `Binding ${name} is not declared.`);
  }
  for (const [name, slot] of Object.entries(declarations)) {
    if (slot.required !== false && !supplied[name]) {
      throw new RgapError('invalid_bindings', `Binding ${name} is required.`);
    }
  }
}

export type InvocationServices = {
  getDefinition(resourceId: ResourceId): Promise<ExecutableDefinition | undefined>;
  authorize(resourceId: ResourceId, permission: Permission): Promise<{ lineage: GrantId[] }>;
  runtimes: RuntimeRegistry;
  recordInvocation(record: InvocationRecord): Promise<void>;
};

/** Audit-safe invocation facts. Inputs, outputs, and runtime values are absent. */
export type InvocationRecord = {
  resourceId: ResourceId;
  runtime: string;
  grantLineage: GrantId[];
  bindings: Record<string, ResourceId>;
  startedAt: string;
  finishedAt: string;
  result: 'done' | 'error' | 'cancelled';
};

/** Resolves, authorizes, parses, and invokes one deployment-owned runtime. */
export async function* invokeExecutable(
  services: InvocationServices,
  resourceId: ResourceId,
  input: InvokeInput,
): AsyncIterable<InvocationEvent> {
  const definition = await services.getDefinition(resourceId);
  if (!definition) throw new RgapError('missing_executable', 'Executable does not exist.');
  const runtime: InvokeRuntime = services.runtimes.get(definition.runtime);
  const authorization = await services.authorize(resourceId, 'invoke');
  const parsedInput = runtime.inputSchema === null
    ? input.input
    : runtime.inputSchema.parse(input.input);
  const supplied = input.bindings ?? {};
  const declarations = runtime.bindings ?? {};
  validateBindings(declarations, supplied);
  for (const boundId of Object.values(supplied)) {
    await services.authorize(boundId, 'invoke');
  }

  const bindings: Record<string, RuntimeBinding> = {};
  for (const [name, boundId] of Object.entries(supplied)) {
    bindings[name] = { resourceId: boundId, kind: declarations[name].kind };
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) cancel();
  else input.signal?.addEventListener('abort', cancel, { once: true });
  const context = {
    input: parsedInput,
    bindings,
    signal: controller.signal,
  };
  const startedAt = new Date().toISOString();
  let result: InvocationRecord['result'] = 'error';
  let exhausted = false;
  let failed = false;
  try {
    const runtimeResult = await runtime.invoke(context);
    if (isAsyncIterable(runtimeResult)) {
      for await (const value of runtimeResult) {
        if (value === undefined) continue;
        const parsed = runtime.outputSchema === null ? value : runtime.outputSchema.parse(value);
        yield { type: 'data', value: parsed };
      }
    } else if (runtimeResult !== undefined) {
      const parsed = runtime.outputSchema === null
        ? runtimeResult
        : runtime.outputSchema.parse(runtimeResult);
      yield { type: 'data', value: parsed };
    }
    exhausted = true;
    result = context.signal.aborted ? 'cancelled' : 'done';
    yield { type: 'done' };
  } catch (error) {
    failed = true;
    result = context.signal.aborted ? 'cancelled' : 'error';
    throw error;
  } finally {
    if (!exhausted && !failed) result = 'cancelled';
    controller.abort();
    input.signal?.removeEventListener('abort', cancel);
    await services.recordInvocation({
      resourceId,
      runtime: definition.runtime,
      grantLineage: [...authorization.lineage],
      bindings: { ...supplied },
      startedAt,
      finishedAt: new Date().toISOString(),
      result,
    });
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return value !== null
    && value !== undefined
    && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function';
}
