import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { systemClock } from './time.js';
import { startWorkers } from './workers.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ db, clock: systemClock, config });
const stopWorkers = startWorkers(db, systemClock, config);

const server = app.listen(config.port, () => {
  console.log(`404-express listening on :${config.port} (autoProgress=${config.autoProgress})`);
});

function shutdown() {
  stopWorkers();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
