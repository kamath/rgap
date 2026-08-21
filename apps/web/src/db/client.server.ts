import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import { rgapSchema } from './schema'

const applicationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

async function createDatabase() {
  const dataDirectory =
    process.env.PGLITE_DATA_DIR ?? path.join(applicationRoot, '.data/rgap')
  if (!dataDirectory.startsWith('memory://')) {
    mkdirSync(path.dirname(dataDirectory), { recursive: true })
  }
  const client = await PGlite.create(dataDirectory)
  const database = drizzle({ client, schema: rgapSchema })

  await migrate(database, {
    migrationsFolder: path.join(applicationRoot, 'drizzle'),
  })

  return database
}

export type RgapDatabase = Awaited<ReturnType<typeof createDatabase>>

const globalDatabase = globalThis as typeof globalThis & {
  __rgapDatabase?: Promise<RgapDatabase>
}

export function getDatabase() {
  globalDatabase.__rgapDatabase ??= createDatabase()
  return globalDatabase.__rgapDatabase
}

export async function createMemoryDatabase() {
  const client = await PGlite.create('memory://')
  const database = drizzle({ client, schema: rgapSchema })
  await migrate(database, {
    migrationsFolder: path.join(applicationRoot, 'drizzle'),
  })
  return database
}
