import session from 'express-session';
import { env } from '../config/env.js';
import { isDatabaseConfigured } from '../db/pool.js';
import { PgSessionStore } from '../services/pgSessionStore.js';

export function createSessionMiddleware() {
    const ttlMs = env.sessionLifetimeMinutes * 60 * 1000;
    const store = isDatabaseConfigured()
        ? new PgSessionStore({ ttlSeconds: env.sessionLifetimeMinutes * 60 })
        : new session.MemoryStore();

    return session({
        name: 'ebarangay_session',
        secret: env.sessionSecret,
        store,
        resave: false,
        saveUninitialized: true,
        rolling: true,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: env.isVercel ? true : 'auto',
            maxAge: ttlMs,
        },
    });
}

export function trackSessionMeta(req, res, next) {
    if (req.session) {
        req.session._meta = {
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '',
            ua: req.get('user-agent') || '',
        };
    }
    next();
}
