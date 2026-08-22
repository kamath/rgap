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

export type RuntimeInvocation<TProgram = unknown, TInput = unknown> = {
  revision: Omit<ExecutableRevision, 'program'> & { program: TProgram };
  input: TInput;
  bindings: Readonly<Record<string, RuntimeBinding>>;
  limits: ExecutionLimits;
  signal: AbortSignal;
};

export type RuntimeResult<T> = T | AsyncIterable<T>;

export interface InvokeRuntime<TProgram = unknown, TInput = unknown, TOutput = unknown> {
  validate(program: unknown): asserts program is TProgram;
  invoke(
    context: RuntimeInvocation<TProgram, TInput>,
  ): RuntimeResult<TOutput> | Promise<RuntimeResult<TOutput>>;
}

type RegisteredRuntime = {
  validate(program: unknown): void;
  invoke(context: never): unknown;
};
export type RuntimeRegistrations =
  | Readonly<Record<string, RegisteredRuntime>>
  | ReadonlyMap<string, RegisteredRuntime>;

/** Deployment-owned registry; repository commands cannot mutate it. */
export class RuntimeRegistry<TRuntimes extends RuntimeRegistrations = RuntimeRegistrations> {
  readonly #runtimes: ReadonlyMap<string, RegisteredRuntime>;

  constructor(runtimes: TRuntimes = {} as TRuntimes) {
    this.#runtimes = runtimes instanceof Map
      ? new Map(runtimes)
      : new Map(Object.entries(runtimes));
  }

  get<K extends keyof TRuntimes & string>(
    name: K,
  ): TRuntimes[K] extends RegisteredRuntime ? TRuntimes[K] : InvokeRuntime;
  get<TProgram = unknown, TInput = unknown, TOutput = unknown>(
    name: string,
  ): InvokeRuntime<TProgram, TInput, TOutput>;
  get<TProgram = unknown, TInput = unknown, TOutput = unknown>(
    name: string,
  ): InvokeRuntime<TProgram, TInput, TOutput> {
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new RgapError('unknown_runtime', `Runtime ${name} is not registered.`);
    // The revision's runtime name selects this existential type. Program validation establishes
    // the concrete program type before invocation; the erasure never escapes the registry.
    return runtime as unknown as InvokeRuntime<TProgram, TInput, TOutput>;
  }

  has(name: string) {
    return this.#runtimes.has(name);
  }
}
