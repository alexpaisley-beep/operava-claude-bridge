import { loadConfig } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { createLogger } from '../logger.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, service: 'migrate' });
const db = createPool(config);

runMigrations(db, { logger })
  .then((applied) => {
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
    return db.end();
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
