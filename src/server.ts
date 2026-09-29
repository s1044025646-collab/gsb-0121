import { createServer } from 'node:net';
import { openDatabase } from './db.js';
import { createApp } from './api.js';

/** Find a free TCP port on localhost. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not acquire port')));
      }
    });
  });
}

async function main(): Promise<void> {
  const dbPath = process.env.ODET_DB ?? 'data/odet.sqlite';
  const { db, close } = openDatabase(dbPath);
  const app = createApp(db);
  const port = process.env.ODET_PORT ? Number(process.env.ODET_PORT) : await pickFreePort();
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`[odet] listening on http://127.0.0.1:${port} (db: ${dbPath})`);
  });
  const shutdown = () => {
    console.log('\n[odet] shutting down ...');
    server.close(() => {
      close();
      console.log('[odet] stopped');
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
