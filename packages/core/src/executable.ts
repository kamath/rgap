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
  type RuntimePrivateMetadata,
  type SecretMetadata,
  type State,
} from './domain';
import {
  RuntimeRegistry,
  type InvocationEvent,
  type JsonSchemaValidator,
  type RuntimeBinding,
  type RuntimeCredentialStore,
  type RuntimePrivateState,
  type RuntimeSecrets,
  type SecretStore,
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

export const validateRuntimeProgram = (runtimes: RuntimeRegistry, runtime: string, program: unknown) =>
  runtimes.get(runtime).validate(program);

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
    if (!['resource', 'secret', 'runtime-private'].includes(slot.kind)) {
      throw new RgapError('invalid_binding_schema', `Binding ${name} has an unknown kind.`);
    }
    if (slot.access !== 'use' && slot.access !== 'write') {
      throw new RgapError('invalid_binding_schema', `Binding ${name} has an unknown access mode.`);
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

export function recordSecretMetadata(state: State, metadata: SecretMetadata) {
  if (!isLive(state.resources[metadata.resourceId])) throw new RgapError('missing_resource', 'Resource does not exist.');
  const next = cloned(state);
  next.secretMetadata[metadata.resourceId] = cloned(metadata);
  return next;
}

export function deleteSecretMetadata(state: State, resourceId: ResourceId) {
  const next = cloned(state);
  delete next.secretMetadata[resourceId];
  return next;
}

export function recordRuntimePrivateMetadata(state: State, metadata: RuntimePrivateMetadata) {
  if (!isLive(state.resources[metadata.resourceId])) throw new RgapError('missing_resource', 'Resource does not exist.');
  const next = cloned(state);
  next.runtimePrivateMetadata[runtimeMetadataKey(metadata.runtime, metadata.resourceId)] = cloned(metadata);
  return next;
}

export const runtimeMetadataKey = (runtime: string, resourceId: ResourceId) => `${runtime}\u0000${resourceId}`;

export function assertJsonSchema(
  validator: JsonSchemaValidator,
  schema: JsonSchema,
  value: unknown,
  subject: string,
) {
  const result = validator.validate(schema, value);
  if (!result.valid) throw new RgapError('schema_validation', `${subject}: ${result.errors.join('; ')}`);
}

/** Validates exact slot names and required slots without touching credentials. */
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
  secrets: SecretStore;
  credentials: RuntimeCredentialStore;
  recordInvocation(record: InvocationRecord): Promise<void>;
};

/** Audit-safe invocation facts. Inputs, outputs, handles, and credential values are absent. */
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

function scopedPrivateState(
  runtime: string,
  schema: Readonly<Record<string, BindingSlot>>,
  supplied: Readonly<Record<string, ResourceId>>,
  store: RuntimeCredentialStore,
): RuntimePrivateState {
  const resourceFor = (slotName: string, write: boolean) => {
    const slot = schema[slotName];
    const resourceId = supplied[slotName];
    if (!slot || slot.kind !== 'runtime-private' || !resourceId) {
      throw new RgapError('invalid_binding', `Binding ${slotName} is not runtime-private.`);
    }
    if (write && slot.access !== 'write') {
      throw new RgapError('unauthorized', `Binding ${slotName} does not permit credential mutation.`);
    }
    return resourceId;
  };
  return {
    metadata: (slot) => store.metadata(runtime, resourceFor(slot, false)),
    handle: (slot) => store.handle(runtime, resourceFor(slot, false)),
    write: (slot, value) => store.write(runtime, resourceFor(slot, true), value),
    delete: (slot) => store.delete(runtime, resourceFor(slot, true)),
  };
}

function scopedSecrets(
  schema: Readonly<Record<string, BindingSlot>>,
  supplied: Readonly<Record<string, ResourceId>>,
  store: SecretStore,
): RuntimeSecrets {
  return {
    resolve(slotName) {
      const slot = schema[slotName];
      const resourceId = supplied[slotName];
      if (!slot || slot.kind !== 'secret' || !resourceId) {
        throw new RgapError('invalid_binding', `Binding ${slotName} is not a secret.`);
      }
      return store.resolve(resourceId);
    },
  };
}

/**
 * Resolves, authorizes, validates, and invokes one immutable revision. Authorization finishes
 * before any secret or runtime-private handle is requested.
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
  assertJsonSchema(services.validator, revision.inputSchema, input.input, 'Invocation input is invalid');
  const supplied = input.bindings ?? {};
  validateBindings(revision.bindingSchema, supplied);
  for (const [name, boundId] of Object.entries(supplied)) {
    await services.authorize(boundId, 'use');
    if (revision.bindingSchema[name].access === 'write') await services.authorize(boundId, 'write');
  }

  const runtime = services.runtimes.get(revision.runtime);
  runtime.validate(revision.program);
  const limits = effectiveExecutionLimits(services.runtimeLimits(revision.runtime), revision.limits);
  const bindings: Record<string, RuntimeBinding> = {};
  for (const [name, boundId] of Object.entries(supplied)) {
    const slot = revision.bindingSchema[name];
    bindings[name] = { resourceId: boundId, kind: slot.kind, access: slot.access };
    if (slot.kind === 'secret') bindings[name].secret = await services.secrets.handle(boundId);
    if (slot.kind === 'runtime-private') {
      bindings[name].credential = await services.credentials.handle(revision.runtime, boundId);
    }
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) cancel();
  else input.signal?.addEventListener('abort', cancel, { once: true });
  const context = {
    revision: cloned(revision),
    input: cloned(input.input),
    bindings,
    limits,
    signal: controller.signal,
    secrets: scopedSecrets(revision.bindingSchema, supplied, services.secrets),
    credentials: scopedPrivateState(revision.runtime, revision.bindingSchema, supplied, services.credentials),
  };
  const startedAt = new Date().toISOString();
  let result: InvocationRecord['result'] = 'error';
  let exhausted = false;
  try {
    for await (const event of runtime.invoke(context)) {
      if (event.type === 'data' && revision.outputSchema) {
        assertJsonSchema(services.validator, revision.outputSchema, event.value, 'Runtime output is invalid');
      }
      if (event.type === 'done') result = 'done';
      yield event;
    }
    exhausted = true;
    if (context.signal.aborted) result = 'cancelled';
  } finally {
    if (!exhausted) result = 'cancelled';
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
