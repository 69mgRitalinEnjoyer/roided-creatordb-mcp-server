import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { migrate } from './db/schema.js';
import { Gateway, installGateway } from './gateway/gateway.js';
import { loadOfficial } from './official/loader.js';
import { PullRunner } from './pulls/pulls.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = await openDb(cfg);
  await migrate(db);

  // From here on, the official tool code's requests are caught by the gateway.
  let upstream: typeof fetch = fetch;
  installGateway((realFetch) => {
    upstream = realFetch;
    return new Gateway({ db, cfg, upstream: realFetch });
  });
  await loadOfficial();

  const runner = new PullRunner({ db, cfg });
  runner.start();

  const app = buildApp({ db, cfg, runner, upstream });
  const server = app.listen(cfg.port, () => {
    console.log(`Roided MCP is listening. Connector URL: ${cfg.publicUrl}/mcp`);
    console.log(cfg.databaseUrl ? 'Database: Postgres' : `Database: embedded Postgres in ${cfg.dataDir}`);
  });

  const shutdown = () => {
    runner.stop();
    server.close(() => void db.close().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
