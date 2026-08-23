import {
  RgapError,
  type BindingSlot,
  type ResourceId,
} from './domain';

export type InvocationEvent =
  | { type: 'data'; value: unknown }
  | { type: 'done' };

/** A structural parser contract implemented directly by libraries such as Zod. */
export type RuntimeSchema<T> = {
  parse(value: unknown): T;
};

export type RuntimeBinding = {
  resourceId: ResourceId;
  kind: BindingSlot['kind'];
};

export type RuntimeInvocation<TInput = unknown> = {
  input: TInput;
  bindings: Readonly<Record<string, RuntimeBinding>>;
  signal: AbortSignal;
};

export type RuntimeResult<T> = T | AsyncIterable<T>;

export interface InvokeRuntime<TInput = unknown, TOutput = unknown> {
  inputSchema: RuntimeSchema<TInput> | null;
  outputSchema: RuntimeSchema<TOutput> | null;
  bindings?: Readonly<Record<string, BindingSlot>>;
  invoke(
    context: RuntimeInvocation<TInput>,
  ): RuntimeResult<TOutput> | Promise<RuntimeResult<TOutput>>;
}

type RegisteredRuntime = InvokeRuntime<any, any>;
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
  get<TInput = unknown, TOutput = unknown>(
    name: string,
  ): InvokeRuntime<TInput, TOutput>;
  get<TInput = unknown, TOutput = unknown>(
    name: string,
  ): InvokeRuntime<TInput, TOutput> {
    const runtime = this.#runtimes.get(name);
    if (!runtime) throw new RgapError('unknown_runtime', `Runtime ${name} is not registered.`);
    // The persisted runtime name selects this existential type; erasure stays inside the registry.
    return runtime as InvokeRuntime<TInput, TOutput>;
  }

  has(name: string) {
    return this.#runtimes.has(name);
  }
}
