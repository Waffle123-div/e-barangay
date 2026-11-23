import { queryOne } from '../db/pool.js';
import { hydrateUser } from '../lib/models.js';

export async function loadUser(req, res, next) {
    req.user = null;
    res.locals.authUser = null;
    res.locals.isAuthenticated = false;
    res.locals.isAdmin = false;
    res.locals.isResident = false;

    const userId = req.session?.userId;
    if (userId) {
        try {
            const row = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [userId]);
            if (row) {
                const user = hydrateUser(row);
                req.user = user;
                res.locals.authUser = user;
                res.locals.isAuthenticated = true;
                const roleLower = String(user.role || '').trim().toLowerCase();
                res.locals.isAdmin = roleLower === 'admin';
                res.locals.isResident = roleLower !== 'admin';
            } else if (req.session) {
                delete req.session.userId;
            }
        } catch (err) {
            console.error('[loadUser error]', err.message);
        }
    }

    next();
}

export function requireAuth(loginRoute = '/resident/login') {
    return (req, res, next) => {
        if (!req.user) {
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(401).json({ success: false, message: 'Unauthenticated.' });
            }
            if (req.method === 'GET' && req.originalUrl && !req.originalUrl.startsWith('/api')) {
                req.session.urlIntended = req.originalUrl;
            }
            return res.redirect(loginRoute);
        }
        next();
    };
}

export function requireGuest(req, res, next) {
    if (req.user) {
        const roleLower = String(req.user.role || '').trim().toLowerCase();
        if (roleLower === 'admin') {
            return res.redirect('/admin');
        }
        const statusLower = String(req.user.status || '').trim().toLowerCase();
        if (statusLower === 'active') return res.redirect('/resident');
        if (statusLower === 'pending_approval') return res.redirect('/resident/pending-approval');
        if (statusLower === 'incomplete') {
            if (!req.user.email_verified_at) return res.redirect('/email/verify');
            return res.redirect('/complete-registration');
        }
    }
    next();
}

export function requireVerified(req, res, next) {
    if (!req.user) return res.redirect('/resident/login');
    if (!req.user.email_verified_at) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(403).json({ success: false, message: 'Email or phone verification required.' });
        }
        return res.redirect('/email/verify');
    }
    next();
}

export function requireAdmin(req, res, next) {
    if (!req.user) {
        return res.redirect('/admin/login');
    }
    const roleLower = String(req.user.role || '').trim().toLowerCase();
    if (roleLower !== 'admin') {
        return res.redirectWithFlash('/resident', { error: 'Access Denied. Admins only.' });
    }
    const statusLower = String(req.user.status || '').trim().toLowerCase();
    if (statusLower !== 'active') {
        req.session.regenerate(() => {
            req.flashErrors({
                email: 'Your administrator account is inactive. Please contact a system administrator.',
            });
            res.redirect('/admin/login');
        });
        return;
    }
    next();
}

export function requireResident(req, res, next) {
    if (!req.user) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ success: false, message: 'Unauthenticated.' });
        }
        return res.redirect('/resident/login');
    }
    const roleLower = String(req.user.role || '').trim().toLowerCase();
    if (roleLower === 'admin') {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(403).json({ success: false, message: 'Access Denied. Residents only.' });
        }
        return res.redirectWithFlash('/admin', { error: 'Access Denied. Residents only.' });
    }
    if (roleLower !== 'resident') {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(403).json({ success: false, message: 'Access Denied. Residents only.' });
        }
        return res.redirectWithFlash('/resident/login', { error: 'Access Denied. Residents only.' });
    }
    next();
}

export function requireResidentPin(req, res, next) {
    const user = req.user;
    if (!user) return res.redirect('/resident/login');

    const routeName = req.routeName || '';

    // Enforce server-side session lock when the resident locked their screen
    if (req.session?.is_locked === true) {
        const allowedWhileLocked = new Set([
            'resident.dashboard',
            'resident.session.unlock',
            'resident.session.lock',
            'resident.logout',
        ]);
        if (!allowedWhileLocked.has(routeName)) {
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(423).json({ message: 'Session is locked. Please unlock with your PIN.' });
            }
            return res.redirectWithFlash(
                '/resident',
                'warning',
                'Your session is locked. Please enter your security PIN to continue.'
            );
        }
    }

    const roleLower = String(user.role || '').trim().toLowerCase();
    const statusLower = String(user.status || '').trim().toLowerCase();
    if (roleLower === 'resident' && statusLower === 'active' && !user.security_pin) {
        if (routeName !== 'resident.dashboard' && routeName !== 'resident.pin.setup') {
            return res.redirectWithFlash(
                '/resident',
                'warning',
                'Please set up your security PIN first.'
            );
        }
    }

    next();
}
