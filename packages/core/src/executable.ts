import {
  RgapError,
  isLive,
  type BindingSlot,
  type ExecutableDefinition,
  type ExecutableRevision,
  type ExecutableRevisionId,
  type ExecutionLimits,
  type GrantId,
  type JsonSchema,
  type Permission,
  type ResourceId,
  type State,
} from './domain';
import {
  RuntimeRegistry,
  type InvokeRuntime,
  type InvocationEvent,
  type JsonSchemaValidator,
  type RuntimeBinding,
} from './runtime';

export type PublishExecutableInput = Omit<ExecutableRevision, 'id' | 'resourceId' | 'createdAt'>;
export type InvokeInput = {
  input: unknown;
  bindings?: Record<string, ResourceId>;
  revisionId?: ExecutableRevisionId;
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

export const validateRuntimeProgram = (runtimes: RuntimeRegistry, runtime: string, program: unknown) => {
  const implementation: InvokeRuntime = runtimes.get(runtime);
  implementation.validate(program);
};

function requirePositiveInteger(value: number | undefined, name: string) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RgapError('invalid_limits', `${name} must be a positive integer.`);
  }
}

/** Validates a revision's host-independent shape. Runtime program validation remains host-owned. */
export function validateExecutableRevision(input: PublishExecutableInput) {
  if (!input.runtime.trim()) throw new RgapError('invalid_runtime', 'Runtime name is required.');
  requirePositiveInteger(input.limits.timeoutMs, 'timeoutMs');
  requirePositiveInteger(input.limits.memoryBytes, 'memoryBytes');
  requirePositiveInteger(input.limits.outputBytes, 'outputBytes');
  requirePositiveInteger(input.limits.concurrency, 'concurrency');
  if (input.limits.network && !Array.isArray(input.limits.network.allowedOrigins)) {
    throw new RgapError('invalid_limits', 'network.allowedOrigins must be an array.');
  }
  for (const [name, slot] of Object.entries(input.bindingSchema)) {
    if (!name.trim()) throw new RgapError('invalid_binding_schema', 'Binding names are required.');
    if (!slot || typeof slot.kind !== 'string' || !slot.kind.trim()) {
      throw new RgapError('invalid_binding_schema', `Binding ${name} requires a kind.`);
    }
    if (Object.keys(slot).some((key) => key !== 'kind' && key !== 'required')) {
      throw new RgapError('invalid_binding_schema', `Binding ${name} contains an unknown property.`);
    }
    if (slot.required !== undefined && typeof slot.required !== 'boolean') {
      throw new RgapError('invalid_binding_schema', `Binding ${name} has an invalid required flag.`);
    }
  }
}

/** Publishes one immutable revision and selects it as active. */
export function publishExecutable(
  state: State,
  resourceId: ResourceId,
  input: PublishExecutableInput,
  id: ExecutableRevisionId,
  at: string,
  validateProgram: (runtime: string, program: unknown) => void,
) {
  if (!isLive(state.resources[resourceId])) throw new RgapError('missing_resource', 'Resource does not exist.');
  if (state.executableRevisions[id]) throw new RgapError('duplicate_id', `Executable revision ${id} already exists.`);
  if (state.executables[resourceId]?.deletedAt) {
    throw new RgapError('deleted_executable', 'A deleted executable cannot publish another revision.');
  }
  validateExecutableRevision(input);
  validateProgram(input.runtime, input.program);
  const revision: ExecutableRevision = {
    ...cloned(input),
    runtime: input.runtime.trim(),
    id,
    resourceId,
    createdAt: at,
  };
  const next = cloned(state);
  next.executableRevisions[id] = revision;
  next.executables[resourceId] = { resourceId, activeRevisionId: id, deletedAt: null };
  next.audit.unshift({
    id: `${at}:executable.publish:${next.audit.length}`,
    at,
    action: 'executable.publish',
    target: resourceId,
    result: 'recorded',
    detail: `Published revision ${id} for runtime ${revision.runtime}.`,
  });
  return next;
}

/** Soft-deletes a definition while retaining all immutable revisions. */
export function deleteExecutable(state: State, resourceId: ResourceId, at: string) {
  const definition = state.executables[resourceId];
  if (!definition || definition.deletedAt) throw new RgapError('missing_executable', 'Executable does not exist.');
  const next = cloned(state);
  next.executables[resourceId].deletedAt = at;
  next.executables[resourceId].activeRevisionId = null;
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

export function assertJsonSchema(
  validator: JsonSchemaValidator,
  schema: JsonSchema,
  value: unknown,
  subject: string,
) {
  const result = validator.validate(schema, value);
  if (!result.valid) throw new RgapError('schema_validation', `${subject}: ${result.errors.join('; ')}`);
}

/** Validates exact slot names and required slots. */
export function validateBindings(
  schema: Readonly<Record<string, BindingSlot>>,
  supplied: Readonly<Record<string, ResourceId>>,
) {
  for (const name of Object.keys(supplied)) {
    if (!schema[name]) throw new RgapError('invalid_bindings', `Binding ${name} is not declared.`);
  }
  for (const [name, slot] of Object.entries(schema)) {
    if (slot.required !== false && !supplied[name]) {
      throw new RgapError('invalid_bindings', `Binding ${name} is required.`);
    }
  }
}

/** Applies a revision's narrower limits to immutable host ceilings. */
export function effectiveExecutionLimits(ceiling: ExecutionLimits, requested: ExecutionLimits) {
  const result: ExecutionLimits = {};
  for (const key of ['timeoutMs', 'memoryBytes', 'outputBytes', 'concurrency'] as const) {
    const host = ceiling[key];
    const revision = requested[key];
    if (host !== undefined && revision !== undefined && revision > host) {
      throw new RgapError('limit_expands', `${key} exceeds the runtime ceiling.`);
    }
    result[key] = revision ?? host;
  }
  const hostOrigins = ceiling.network?.allowedOrigins;
  const requestedOrigins = requested.network?.allowedOrigins;
  if (hostOrigins && requestedOrigins?.some((origin) => !hostOrigins.includes(origin))) {
    throw new RgapError('limit_expands', 'Network origins exceed the runtime ceiling.');
  }
  if (requestedOrigins || hostOrigins) {
    result.network = { allowedOrigins: [...(requestedOrigins ?? hostOrigins!)] };
  }
  return result;
}

export type InvocationServices = {
  getDefinition(resourceId: ResourceId): Promise<ExecutableDefinition | undefined>;
  getRevision(id: ExecutableRevisionId): Promise<ExecutableRevision | undefined>;
  authorize(resourceId: ResourceId, permission: Permission): Promise<{ lineage: GrantId[] }>;
  runtimes: RuntimeRegistry;
  validator: JsonSchemaValidator;
  runtimeLimits(runtime: string): ExecutionLimits;
  recordInvocation(record: InvocationRecord): Promise<void>;
};

/** Audit-safe invocation facts. Inputs, outputs, and runtime values are absent. */
export type InvocationRecord = {
  resourceId: ResourceId;
  revisionId: ExecutableRevisionId;
  runtime: string;
  grantLineage: GrantId[];
  bindings: Record<string, ResourceId>;
  startedAt: string;
  finishedAt: string;
  result: 'done' | 'error' | 'cancelled';
};

/**
 * Resolves, authorizes, validates, and invokes one immutable revision.
 */
export async function* invokeExecutable(
  services: InvocationServices,
  resourceId: ResourceId,
  input: InvokeInput,
): AsyncIterable<InvocationEvent> {
  const definition = await services.getDefinition(resourceId);
  if (!definition || definition.deletedAt) throw new RgapError('missing_executable', 'Executable does not exist.');
  const revisionId = input.revisionId ?? definition.activeRevisionId;
  if (!revisionId) throw new RgapError('missing_revision', 'Executable has no active revision.');
  const revision = await services.getRevision(revisionId);
  if (!revision || revision.resourceId !== resourceId) {
    throw new RgapError('missing_revision', 'Executable revision does not exist on this resource.');
  }

  const authorization = await services.authorize(resourceId, 'invoke');
  if (revision.inputSchema !== null) {
    assertJsonSchema(services.validator, revision.inputSchema, input.input, 'Invocation input is invalid');
  }
  const supplied = input.bindings ?? {};
  validateBindings(revision.bindingSchema, supplied);
  for (const boundId of Object.values(supplied)) {
    await services.authorize(boundId, 'invoke');
  }

  const runtime: InvokeRuntime = services.runtimes.get(revision.runtime);
  const program = revision.program;
  runtime.validate(program);
  const limits = effectiveExecutionLimits(services.runtimeLimits(revision.runtime), revision.limits);
  const bindings: Record<string, RuntimeBinding> = {};
  for (const [name, boundId] of Object.entries(supplied)) {
    const slot = revision.bindingSchema[name];
    bindings[name] = { resourceId: boundId, kind: slot.kind };
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) cancel();
  else input.signal?.addEventListener('abort', cancel, { once: true });
  const context = {
    revision: { ...cloned(revision), program: cloned(program) },
    input: cloned(input.input),
    bindings,
    limits,
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
        if (revision.outputSchema !== null) {
          assertJsonSchema(services.validator, revision.outputSchema, value, 'Runtime output is invalid');
        }
        yield { type: 'data', value };
      }
    } else if (runtimeResult !== undefined) {
      if (revision.outputSchema !== null) {
        assertJsonSchema(services.validator, revision.outputSchema, runtimeResult, 'Runtime output is invalid');
      }
      yield { type: 'data', value: runtimeResult };
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
      revisionId,
      runtime: revision.runtime,
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
