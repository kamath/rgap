import { serve } from '@hono/node-server';
import { SqliteRgapStore } from '@rgap/sqlite';
import { createApp } from './app';

const adminToken = process.env.RGAP_ADMIN_TOKEN ?? 'test';

const store = new SqliteRgapStore({
  url: process.env.RGAP_DATABASE_URL ?? 'rgap.db',
});
const port = Number(process.env.PORT ?? 3000);
const app = createApp({ store, adminToken });

const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`RGAP API listening on http://localhost:${listeningPort}`);
});

function close() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
