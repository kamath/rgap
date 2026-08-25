import postgres, {
  type Options,
  type Sql,
} from 'postgres';

export type Awaitable<T> = T | Promise<T>;

export interface CredentialStore<T> {
  get(resourceId: string): Awaitable<T | undefined>;
  set(resourceId: string, value: T): Awaitable<void>;
  update(
    resourceId: string,
    update: (current: T | undefined) => T,
  ): Awaitable<T>;
  delete(resourceId: string): Awaitable<void>;
  close(): Awaitable<void>;
}

export type PostgresCredentialStoreOptions = {
  url: string;
  connection?: Options<Record<string, never>>;
};

type StoredCredential = {
  value: string;
};

export class PostgresCredentialStore<T> implements CredentialStore<T> {
  readonly #connection: Sql;

  constructor(options: PostgresCredentialStoreOptions) {
    this.#connection = postgres(options.url, options.connection);
  }

  async migrate() {
    await this.#connection`
      CREATE TABLE IF NOT EXISTS credentials (
        resource_id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;
  }

  async get(resourceId: string) {
    const [stored] = await this.#connection<StoredCredential[]>`
      SELECT value
      FROM credentials
      WHERE resource_id = ${resourceId}
    `;
    return stored === undefined ? undefined : JSON.parse(stored.value) as T;
  }

  async set(resourceId: string, value: T) {
    const serialized = serialize(value);
    await this.#connection`
      INSERT INTO credentials (resource_id, value)
      VALUES (${resourceId}, ${serialized})
      ON CONFLICT (resource_id) DO UPDATE
      SET value = excluded.value
    `;
  }

  async update(
    resourceId: string,
    update: (current: T | undefined) => T,
  ) {
    return this.#connection.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${resourceId}, 0))
      `;
      const [stored] = await transaction<StoredCredential[]>`
        SELECT value
        FROM credentials
        WHERE resource_id = ${resourceId}
      `;
      const current = stored === undefined
        ? undefined
        : JSON.parse(stored.value) as T;
      const next = update(current);
      const serialized = serialize(next);
      await transaction`
        INSERT INTO credentials (resource_id, value)
        VALUES (${resourceId}, ${serialized})
        ON CONFLICT (resource_id) DO UPDATE
        SET value = excluded.value
      `;
      return next;
    });
  }

  async delete(resourceId: string) {
    await this.#connection`
      DELETE FROM credentials
      WHERE resource_id = ${resourceId}
    `;
  }

  async close() {
    await this.#connection.end();
  }
}

function serialize(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Credential values must be JSON-serializable.');
  }
  return serialized;
}
