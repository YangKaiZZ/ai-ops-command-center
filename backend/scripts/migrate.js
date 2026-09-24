// Database migrations (see src/db/migrator.js):
//   npm run migrate                  apply pending migrations (the Docker image does this on every start)
//   npm run migrate:status           what has run on this database and what's pending
//   npm run migrate:new -- <name>    create migrations/NNN_<name>.sql for a schema change
const path = require('path');
process.chdir(path.join(__dirname, '..')); // so dotenv finds the backend .env

const { migrate, status, createMigration } = require('../src/db/migrator');

async function main() {
  const [command = 'up', ...args] = process.argv.slice(2);

  if (command === 'up') {
    const applied = await migrate();
    console.log(applied.length ? `Applied ${applied.length} migration(s). Database is up to date.` : 'Database is up to date.');
    return;
  }

  if (command === 'status') {
    const { rows, missing, databaseExists, legacy } = await status();
    if (!databaseExists) console.log('The database does not exist yet; npm run migrate creates it.');
    if (legacy) console.log('This database was set up before versioned migrations; npm run migrate brings it up to 001 and records it.');
    for (const r of rows) {
      const when = r.appliedAt ? `  ${new Date(r.appliedAt).toISOString().slice(0, 16).replace('T', ' ')}` : '';
      console.log(`  ${r.state.padEnd(8)} ${r.file}${when}`);
    }
    for (const m of missing) console.log(`  missing  ${m.version} (ran here, file is gone)`);
    const pending = rows.filter((r) => r.state === 'pending').length;
    console.log(pending ? `${pending} pending.` : 'Nothing pending.');
    if (rows.some((r) => r.state === 'changed')) process.exitCode = 1;
    return;
  }

  if (command === 'new') {
    console.log(`Created migrations/${createMigration(args.join('_'))}`);
    return;
  }

  throw new Error(`unknown command "${command}" (use: up, status, new <name>)`);
}

main().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  process.exitCode = 1;
});
