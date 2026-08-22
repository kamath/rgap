import {
  RgapError,
  type BindingSlot,
  type ExecutableRevision,
  type ExecutionLimits,
  type JsonSchema,
  type ResourceId,
  type RuntimePrivateMetadata,
  type SecretMetadata,
} from './domain';

export type InvocationEvent =
  | { type: 'data'; value: unknown }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

/** Hosts inject a standards-compliant implementation such as Ajv. */
export interface JsonSchemaValidator {
  validate(schema: JsonSchema, value: unknown): ValidationResult;
}

/** A protected value reference that only trusted host code can resolve at a controlled sink. */
export interface SecretHandle {
  readonly resourceId: ResourceId;
  readonly kind: 'secret';
}

/** A runtime-owned credential reference. It contains no credential material. */
export interface RuntimeCredentialHandle {
  readonly runtime: string;
  readonly resourceId: ResourceId;
  readonly kind: 'runtime-credential';
}

export interface SecretStore {
  write(resourceId: ResourceId, value: string): Promise<SecretMetadata>;
  delete(resourceId: ResourceId): Promise<void>;
  handle(resourceId: ResourceId): Promise<SecretHandle>;
  /** Trusted plaintext access. Repository command planes never expose this operation. */
  resolve(resourceId: ResourceId): Promise<string>;
}

/**
 * Host persistence for runtime-private credential state. Only the orchestrator gives a runtime a
 * scoped view of these operations; executable programs and repository clients never receive it.
 */
export interface RuntimeCredentialStore {
  metadata(runtime: string, resourceId: ResourceId): Promise<RuntimePrivateMetadata | undefined>;
  handle(runtime: string, resourceId: ResourceId): Promise<RuntimeCredentialHandle | undefined>;
  write(runtime: string, resourceId: ResourceId, value: unknown): Promise<RuntimePrivateMetadata>;
  delete(runtime: string, resourceId: ResourceId): Promise<void>;
}

export type RuntimeBinding = {
  resourceId: ResourceId;
  kind: BindingSlot['kind'];
  access: BindingSlot['access'];
  secret?: SecretHandle;
  credential?: RuntimeCredentialHandle;
};

/** Runtime-scoped private state; slot names prevent access to undeclared resources. */
export interface RuntimePrivateState {
  metadata(slot: string): Promise<RuntimePrivateMetadata | undefined>;
  handle(slot: string): Promise<RuntimeCredentialHandle | undefined>;
  write(slot: string, value: unknown): Promise<RuntimePrivateMetadata>;
  delete(slot: string): Promise<void>;
}

export type RuntimeInvocation = {
  revision: ExecutableRevision;
  input: unknown;
  bindings: Readonly<Record<string, RuntimeBinding>>;
  limits: ExecutionLimits;
  signal: AbortSignal;
  credentials: RuntimePrivateState;
};

export interface InvokeRuntime {
  validate(program: unknown): void;
  invoke(context: RuntimeInvocation): AsyncIterable<InvocationEvent>;
}

/** Deployment-owned registry; repository commands cannot mutate it. */
export class RuntimeRegistry {
  readonly #runtimes: ReadonlyMap<string, InvokeRuntime>;

  constructor(runtimes: Readonly<Record<string, InvokeRuntime>> | ReadonlyMap<string, InvokeRuntime> = {}) {
    this.#runtimes = runtimes instanceof Map
      ? new Map(runtimes)
      : new Map(Object.entries(runtimes as Readonly<Record<string, InvokeRuntime>>));
  }

  get(name: string) {
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new RgapError('unknown_runtime', `Runtime ${name} is not registered.`);
    return runtime;
  }

  has(name: string) {
    return this.#runtimes.has(name);
  }
}
