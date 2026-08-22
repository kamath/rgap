import { SqliteRgapStore } from '@rgap/sqlite';
import { databaseUrl } from './config';

export const store = new SqliteRgapStore({ url: databaseUrl() });
