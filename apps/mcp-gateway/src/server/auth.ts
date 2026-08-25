import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { bearer } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { appUrl, authSecret, dataPath } from './config'

const database = new Database(dataPath('auth.db'))
database.pragma('journal_mode = WAL')
database.pragma('foreign_keys = ON')

export const auth = betterAuth({
  appName: 'RGAP MCP Gateway',
  baseURL: appUrl.origin,
  secret: authSecret(),
  trustedOrigins: [appUrl.origin],
  database,
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    bearer({ requireSignature: true }),
    tanstackStartCookies(),
  ],
})

const ready = getMigrations(auth.options).then(({ runMigrations }) =>
  runMigrations(),
)

export async function ensureAuthReady() {
  await ready
}

export async function requireSession(headers: Headers) {
  await ensureAuthReady()
  const session = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
  })
  if (!session) {
    throw new Response('Authentication required.', { status: 401 })
  }
  return session
}
