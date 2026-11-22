import { queryOne } from '../db/pool.js';
import { verifySecret } from '../lib/password.js';
import { limit10PerMin } from '../middleware/rateLimit.js';

export function registerAdminAuthRoutes(app) {
    app.get('/admin/login', (req, res) => {
        req.routeName = 'admin.login';
        res.locals.currentRoute = 'admin.login';

        if (req.user) {
            if (String(req.user.role || '').trim().toLowerCase() === 'admin') {
                return res.redirect('/admin');
            }
            return res.redirect('/resident');
        }

        return res.render('admin/auth/login');
    });

    app.post('/admin/login', limit10PerMin, async (req, res) => {
        const email = String(req.body?.email || '').trim();
        const password = String(req.body?.password || '');
        const remember = Boolean(req.body?.remember);

        if (!email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.redirectBackWithErrors(
                { email: 'Please provide a valid email address and password.' },
                { email },
                '/admin/login'
            );
        }

        try {
            const user = await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
            if (user && (await verifySecret(password, user.password))) {
                const roleLower = String(user.role || '').trim().toLowerCase();
                if (roleLower === 'admin') {
                    if (String(user.status || '').trim().toLowerCase() !== 'active') {
                        return res.redirectBackWithErrors(
                            { email: 'Your administrator account is inactive. Please contact a system administrator.' },
                            { email },
                            '/admin/login'
                        );
                    }

                    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
                    req.session.userId = Number(user.id);
                    if (remember) {
                        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
                    }
                    return res.redirect('/admin');
                }

                await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
                req.session.userId = Number(user.id);
                return res.redirect('/resident');
            }
        } catch (err) {
            console.error('Admin login error:', err.message);
            return res.redirectBackWithErrors(
                { email: 'Unable to sign in because the database is unavailable or not migrated yet.' },
                { email },
                '/admin/login'
            );
        }

        return res.redirectBackWithErrors(
            { email: 'The provided credentials do not match our records.' },
            { email },
            '/admin/login'
        );
    });

    app.post('/admin/logout', (req, res) => {
        req.session.destroy(() => {
            res.clearCookie('ebarangay_session');
            res.redirect('/admin/login');
        });
    });
}
