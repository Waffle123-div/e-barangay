import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

let pool = null;

function isLocalConnection(connStr) {
    return /@(localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(connStr) || /host=(localhost|127\.0\.0\.1)/i.test(connStr);
}

export function isDatabaseConfigured() {
    return Boolean(env.databaseUrl);
}

export function getPool() {
    if (!env.databaseUrl) {
        throw new Error('DATABASE_URL is not configured. Please set DATABASE_URL in .env or Vercel environment variables.');
    }

    if (!pool) {
        const useSsl = !isLocalConnection(env.databaseUrl);
        pool = new Pool({
            connectionString: env.databaseUrl,
            ssl: useSsl ? { rejectUnauthorized: false } : false,
            max: env.isVercel ? 5 : 10,
            idleTimeoutMillis: 20000,
            connectionTimeoutMillis: 10000,
        });

        pool.on('error', (err) => {
            console.error('[PostgreSQL Pool Error]', err.message);
        });
    }

    return pool;
}

export async function query(text, params = []) {
    return getPool().query(text, params);
}

export async function queryOne(text, params = []) {
    const res = await getPool().query(text, params);
    return res.rows[0] || null;
}

export async function withTransaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

export async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
