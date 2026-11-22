import crypto from 'crypto';
import { escapeHtml } from '../lib/viewHelpers.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function ensureCsrfToken(req) {
    if (!req.session) return '';
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    return req.session.csrfToken;
}

export function attachCsrfLocals(req, res, next) {
    const token = ensureCsrfToken(req);
    res.locals.csrfToken = token;
    res.locals.csrf_token = () => token;
    res.locals.csrf_field = () => `<input type="hidden" name="_token" value="${escapeHtml(token)}">`;
    next();
}

export function validateCsrfTokenValue(req, provided) {
    const expected = req.session?.csrfToken;
    if (!expected || !provided || typeof provided !== 'string') return false;
    const bufA = Buffer.from(expected, 'utf8');
    const bufB = Buffer.from(provided, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyCsrf(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    // Defer multipart/form-data checks until after multer parses fields unless header already provides a valid token
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const headerToken = req.headers['x-csrf-token'];
    if (contentType.startsWith('multipart/form-data') && !req.body && !headerToken) {
        req._deferCsrfToMultipart = true;
        return next();
    }

    const provided = headerToken || req.body?._token;
    if (!validateCsrfTokenValue(req, typeof provided === 'string' ? provided : '')) {
        const wantsJson = req.xhr || req.headers.accept?.includes('application/json');
        if (wantsJson) {
            return res.status(419).json({
                success: false,
                message: 'CSRF token mismatch. Please refresh the page and try again.',
            });
        }
        return res.status(403).send('Forbidden: Invalid or missing CSRF token. Please go back, refresh, and try again.');
    }

    next();
}

/**
 * Use right after multer() on multipart routes to enforce CSRF & optional _method override.
 */
export function verifyMultipartCsrfAndMethod(req, res, next) {
    const provided = req.headers['x-csrf-token'] || req.body?._token;
    if (!validateCsrfTokenValue(req, typeof provided === 'string' ? provided : '')) {
        const wantsJson = req.xhr || req.headers.accept?.includes('application/json');
        if (wantsJson) {
            return res.status(419).json({
                success: false,
                message: 'CSRF token mismatch. Please refresh the page and try again.',
            });
        }
        return res.status(403).send('Forbidden: Invalid or missing CSRF token.');
    }
    if (req.body?._method && typeof req.body._method === 'string') {
        req.method = req.body._method.toUpperCase();
    }
    next();
}
