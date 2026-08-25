import Database from 'better-sqlite3';

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

export class SqliteCredentialStore<T> implements CredentialStore<T> {
  readonly #database: Database.Database;
  readonly #select: Database.Statement<[string], { value: string }>;
  readonly #set: Database.Statement<[string, string]>;
  readonly #delete: Database.Statement<[string]>;
  readonly #updateTransaction: (
    resourceId: string,
    update: (current: T | undefined) => T,
  ) => T;

  constructor(url = ':memory:') {
    this.#database = new Database(url);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        resource_id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.#select = this.#database.prepare(
      'SELECT value FROM credentials WHERE resource_id = ?',
    );
    this.#set = this.#database.prepare(`
      INSERT INTO credentials (resource_id, value) VALUES (?, ?)
      ON CONFLICT (resource_id) DO UPDATE SET value = excluded.value
    `);
    this.#delete = this.#database.prepare(
      'DELETE FROM credentials WHERE resource_id = ?',
    );
    this.#updateTransaction = this.#database.transaction((resourceId, update) => {
      const next = update(this.get(resourceId));
      this.set(resourceId, next);
      return next;
    });
  }

  get(resourceId: string) {
    const stored = this.#select.get(resourceId);
    return stored === undefined ? undefined : JSON.parse(stored.value) as T;
  }

  set(resourceId: string, value: T) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Credential values must be JSON-serializable.');
    }
    this.#set.run(resourceId, serialized);
  }

  update(resourceId: string, update: (current: T | undefined) => T) {
    return this.#updateTransaction(resourceId, update);
  }

  delete(resourceId: string) {
    this.#delete.run(resourceId);
  }

  close() {
    this.#database.close();
  }
}
