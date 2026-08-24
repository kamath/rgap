import {
  RgapError,
  isLive,
  resourceId as toResourceId,
  type ExecutableDefinition,
  type GrantId,
  type JsonValue,
  type Permission,
  type ResourceId,
  type State,
} from './domain';
import {
  RuntimeRegistry,
  type InvocationEvent,
  type InvokeRuntime,
} from './runtime';

export type SetExecutableInput = {
  runtime: string;
  input?: Record<string, JsonValue>;
  bind?: Record<string, ResourceId>;
};
export type InvokeInput = {
  input: unknown;
  signal?: AbortSignal;
};

const authorizedLineage = Symbol('authorized invocation lineage');
const authorizedBindings = Symbol('authorized executable bindings');
type AuthorizedInvokeInput = InvokeInput & { [authorizedLineage]?: GrantId[] };
type AuthorizedSetExecutableInput = SetExecutableInput & {
  [authorizedBindings]?: Record<string, GrantId[]>;
};

/** Internal command-plane context attached by the bearer guard after it authorizes invocation. */
export function withAuthorizedLineage(input: InvokeInput, lineage: GrantId[]): InvokeInput {
  const authorized = { ...input } as AuthorizedInvokeInput;
  Object.defineProperty(authorized, authorizedLineage, { value: [...lineage] });
  return authorized;
}

/** Returns command-plane context without exposing it on the JSON invocation shape. */
export function getAuthorizedLineage(input: InvokeInput) {
  const lineage = (input as AuthorizedInvokeInput)[authorizedLineage];
  return lineage ? [...lineage] : null;
}

/** Attaches binding authorization without exposing it in the executable JSON shape. */
export function withAuthorizedBindings(
  input: SetExecutableInput,
  bindings: Record<string, GrantId[]>,
): SetExecutableInput {
  const authorized = { ...input } as AuthorizedSetExecutableInput;
  Object.defineProperty(authorized, authorizedBindings, {
    value: Object.fromEntries(
      Object.entries(bindings).map(([name, lineage]) => [name, [...lineage]]),
    ),
  });
  return authorized;
}

function getAuthorizedBindings(input: SetExecutableInput) {
  return (input as AuthorizedSetExecutableInput)[authorizedBindings];
}

const cloned = <T>(value: T): T => structuredClone(value);
const invalidSealedNames = new Set(['__proto__', 'prototype', 'constructor']);

function configuredInput(input: SetExecutableInput['input']): Record<string, JsonValue> {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RgapError('invalid_executable_input', 'Executable input must be an object.');
  }
  return Object.fromEntries(Object.entries(input).map(([name, value]) => {
    if (invalidSealedNames.has(name)) {
      throw new RgapError('invalid_executable_input', `Executable input name ${name} is reserved.`);
    }
    return [name, jsonValue(value, name)];
  }));
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RgapError('invalid_executable_input', `Executable input ${path} must be JSON-compatible.`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, jsonValue(entry, `${path}.${name}`)]),
    );
  }
  throw new RgapError('invalid_executable_input', `Executable input ${path} must be JSON-compatible.`);
}

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
  const configured = configuredInput(input.input);
  const authorized = getAuthorizedBindings(input);
  const bind = Object.fromEntries(Object.entries(input.bind ?? {}).map(([name, boundId]) => {
    if (invalidSealedNames.has(name)) {
      throw new RgapError('invalid_bindings', `Binding name ${name} is reserved.`);
    }
    if (Object.prototype.hasOwnProperty.call(configured, name)) {
      throw new RgapError('invalid_bindings', `Binding ${name} conflicts with executable input.`);
    }
    if (!isLive(state.resources[boundId])) {
      throw new RgapError('missing_resource', `Bound resource ${boundId} does not exist.`);
    }
    const lineage = authorized?.[name];
    if (authorized && !lineage) {
      throw new RgapError('unauthorized', `Binding ${name} was not authorized.`);
    }
    return [name, {
      resourceId: boundId,
      grantLineage: lineage ? [...lineage] : null,
    }];
  }));
  const next = cloned(state);
  next.executables[resourceId] = { resourceId, runtime, input: configured, bind };
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

export type InvocationServices = {
  getDefinition(resourceId: ResourceId): Promise<ExecutableDefinition | undefined>;
  authorize(
    resourceId: ResourceId,
    permission: Permission,
    lineage: GrantId[] | null,
  ): Promise<{ lineage: GrantId[] }>;
  runtimes: RuntimeRegistry;
  createInvocationId(): string;
  recordInvocation(record: InvocationRecord): Promise<void>;
};

/** Audit-safe invocation facts. Inputs, outputs, and runtime values are absent. */
export type InvocationRecord = {
  id: string;
  parentInvocationId: string | null;
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
  const callerLineage = getAuthorizedLineage(input);
  yield* invokeFrame(services, resourceId, input, {
    authorization: { permission: 'invoke', lineage: callerLineage },
    callerLineage,
    parentInvocationId: null,
    stack: [],
  });
}

const maximumInvocationDepth = 32;
type FrameState = {
  authorization: { permission: 'invoke' | 'bind'; lineage: GrantId[] | null };
  callerLineage: GrantId[] | null;
  parentInvocationId: string | null;
  stack: ResourceId[];
};

async function* invokeFrame(
  services: InvocationServices,
  resourceId: ResourceId,
  input: InvokeInput,
  frame: FrameState,
): AsyncIterable<InvocationEvent> {
  if (frame.stack.includes(resourceId)) {
    throw new RgapError('invocation_cycle', 'Nested invocation contains an active resource cycle.');
  }
  if (frame.stack.length >= maximumInvocationDepth) {
    throw new RgapError('invocation_depth', `Nested invocation exceeds ${maximumInvocationDepth} frames.`);
  }
  const definition = await services.getDefinition(resourceId);
  if (!definition) throw new RgapError('missing_executable', 'Executable does not exist.');
  const runtime: InvokeRuntime = services.runtimes.get(definition.runtime);
  const authorization = await services.authorize(
    resourceId,
    frame.authorization.permission,
    frame.authorization.lineage,
  );
  for (const binding of Object.values(definition.bind)) {
    await services.authorize(binding.resourceId, 'bind', binding.grantLineage);
  }

  let completeInput = input.input;
  const configuredEntries = Object.entries(definition.input);
  const bindingEntries = Object.entries(definition.bind);
  if (configuredEntries.length || bindingEntries.length) {
    if (
      completeInput === null ||
      typeof completeInput !== 'object' ||
      Array.isArray(completeInput)
    ) {
      throw new RgapError('invalid_input', 'Invocation input must be an object when bindings exist.');
    }
    for (const [name] of [...configuredEntries, ...bindingEntries]) {
      if (Object.prototype.hasOwnProperty.call(completeInput, name)) {
        throw new RgapError('invalid_input', `Invocation input cannot override sealed field ${name}.`);
      }
    }
    const merged = Object.assign(Object.create(null), completeInput);
    for (const [name, value] of configuredEntries) merged[name] = cloned(value);
    for (const [name, binding] of bindingEntries) merged[name] = binding.resourceId;
    completeInput = merged;
  }
  const parsedInput = runtime.inputSchema === null
    ? completeInput
    : runtime.inputSchema.parse(completeInput);

  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) cancel();
  else input.signal?.addEventListener('abort', cancel, { once: true });
  const invocationId = services.createInvocationId();
  const stack = [...frame.stack, resourceId];
  const stream = (target: string, nested: { input: unknown }) => {
    const targetId = toResourceId(target);
    const direct = Object.values(definition.bind)
      .find((binding) => binding.resourceId === targetId);
    const authorization = direct
      ? { permission: 'bind' as const, lineage: direct.grantLineage }
      : { permission: 'invoke' as const, lineage: frame.callerLineage };
    return invokeFrame(services, targetId, {
      input: nested.input,
      signal: controller.signal,
    }, {
      authorization,
      callerLineage: frame.callerLineage,
      parentInvocationId: invocationId,
      stack,
    });
  };
  const one = async <T>(target: string, nested: { input: unknown }) => {
    let value: T | undefined;
    let count = 0;
    for await (const event of stream(target, nested)) {
      if (event.type !== 'data') continue;
      count += 1;
      if (count > 1) {
        throw new RgapError('invalid_nested_result', 'Nested invocation returned more than one value.');
      }
      value = event.value as T;
    }
    if (count !== 1) {
      throw new RgapError('invalid_nested_result', 'Nested invocation did not return exactly one value.');
    }
    return value as T;
  };
  const context = {
    input: parsedInput,
    invoke: { stream, one },
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
      id: invocationId,
      parentInvocationId: frame.parentInvocationId,
      resourceId,
      runtime: definition.runtime,
      grantLineage: [...authorization.lineage],
      bindings: Object.fromEntries(
        bindingEntries.map(([name, binding]) => [name, binding.resourceId]),
      ),
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
