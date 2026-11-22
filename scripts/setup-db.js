import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '../src/config/env.js';
import { closePool, getPool, isDatabaseConfigured } from '../src/db/pool.js';

async function main() {
    if (!isDatabaseConfigured()) {
        console.error('Error: DATABASE_URL is not set. Add it to .env before running db:setup.');
        process.exit(1);
    }

    const schemaPath = path.join(ROOT_DIR, 'supabase', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const pool = getPool();

    console.log('Running supabase/schema.sql against PostgreSQL...');
    await pool.query(sql);
    console.log('Database schema and seed data applied successfully.');
}

main()
    .catch((err) => {
        console.error('db:setup failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await closePool();
    });
