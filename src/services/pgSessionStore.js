import session from 'express-session';
import { query, queryOne } from '../db/pool.js';

export class PgSessionStore extends session.Store {
    constructor(options = {}) {
        super();
        this.ttlSeconds = options.ttlSeconds || 7200;
    }

    async get(sid, callback) {
        try {
            const minActivity = Math.floor(Date.now() / 1000) - this.ttlSeconds;
            const row = await queryOne(
                'SELECT payload, last_activity FROM sessions WHERE id = $1 LIMIT 1',
                [sid]
            );
            if (!row) return callback(null, null);
            if (Number(row.last_activity) < minActivity) {
                await query('DELETE FROM sessions WHERE id = $1', [sid]);
                return callback(null, null);
            }
            const data = JSON.parse(row.payload);
            return callback(null, data);
        } catch (err) {
            return callback(err);
        }
    }

    async set(sid, sess, callback) {
        try {
            const userId = sess?.userId ? Number(sess.userId) : null;
            const ipAddress = sess?._meta?.ip ? String(sess._meta.ip).slice(0, 45) : null;
            const userAgent = sess?._meta?.ua ? String(sess._meta.ua) : null;
            const lastActivity = Math.floor(Date.now() / 1000);
            const payload = JSON.stringify(sess);

            await query(
                `INSERT INTO sessions (id, user_id, ip_address, user_agent, payload, last_activity)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO UPDATE SET
                   user_id = EXCLUDED.user_id,
                   ip_address = EXCLUDED.ip_address,
                   user_agent = EXCLUDED.user_agent,
                   payload = EXCLUDED.payload,
                   last_activity = EXCLUDED.last_activity`,
                [sid, userId, ipAddress, userAgent, payload, lastActivity]
            );
            return callback && callback(null);
        } catch (err) {
            return callback && callback(err);
        }
    }

    async destroy(sid, callback) {
        try {
            await query('DELETE FROM sessions WHERE id = $1', [sid]);
            return callback && callback(null);
        } catch (err) {
            return callback && callback(err);
        }
    }

    async touch(sid, sess, callback) {
        try {
            const lastActivity = Math.floor(Date.now() / 1000);
            const userId = sess?.userId ? Number(sess.userId) : null;
            await query(
                'UPDATE sessions SET last_activity = $2, user_id = COALESCE($3, user_id) WHERE id = $1',
                [sid, lastActivity, userId]
            );
            return callback && callback(null);
        } catch (err) {
            return callback && callback(err);
        }
    }
}
