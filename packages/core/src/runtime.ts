import {
  RgapError,
  type BindingSlot,
  type ExecutableRevision,
  type ExecutionLimits,
  type JsonSchema,
  type ResourceId,
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

export type RuntimeBinding = {
  resourceId: ResourceId;
  kind: BindingSlot['kind'];
};

export type RuntimeInvocation = {
  revision: ExecutableRevision;
  input: unknown;
  bindings: Readonly<Record<string, RuntimeBinding>>;
  limits: ExecutionLimits;
  signal: AbortSignal;
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
