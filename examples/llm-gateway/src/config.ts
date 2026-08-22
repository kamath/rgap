import { SqliteRgapStore } from '@rgap/sqlite';
import { EncryptedSqliteSecretStore, secretKey } from './secret-store';

export function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function databaseUrl() {
  return process.env.RGAP_DATABASE_URL?.trim() || 'llm-gateway.db';
}

export function serverPort() {
  const value = Number(process.env.PORT ?? 8787);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535.');
  }
  return value;
}

const url = databaseUrl();
export const secrets = new EncryptedSqliteSecretStore(url, secretKey);
export const store = new SqliteRgapStore({ url, secrets });
