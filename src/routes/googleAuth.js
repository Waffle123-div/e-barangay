import crypto from 'crypto';
import { env, resolveGoogleRedirectUrl } from '../config/env.js';
import { query, queryOne } from '../db/pool.js';
import { sanitizeIntendedUrl } from '../lib/validators.js';

export function registerGoogleAuthRoutes(app) {
    app.get('/auth/google', (req, res) => {
        if (!env.googleClientId || !env.googleClientSecret) {
            req.flashErrors({ email: 'Google Sign-In is not configured yet.' });
            return res.redirect('/resident/login');
        }

        const intended = sanitizeIntendedUrl(req.query.intended);
        if (intended) {
            req.session.urlIntended = intended;
        }

        const state = crypto.randomBytes(24).toString('hex');
        req.session.googleOAuthState = state;

        const redirectUri = resolveGoogleRedirectUrl(req);
        const params = new URLSearchParams({
            client_id: env.googleClientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            prompt: 'select_account',
        });

        return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    });

    app.get('/auth/google/callback', async (req, res) => {
        try {
            const { code, state } = req.query;
            const expectedState = req.session?.googleOAuthState;
            delete req.session.googleOAuthState;

            if (!code || !state || !expectedState || state !== expectedState) {
                req.flashErrors({ email: 'Unable to complete Google sign-in. Please try again.' });
                return res.redirect('/resident/login');
            }

            const redirectUri = resolveGoogleRedirectUrl(req);
            const tokenParams = new URLSearchParams({
                code: String(code),
                client_id: env.googleClientId,
                client_secret: env.googleClientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            });

            const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: tokenParams.toString(),
            });
            if (!tokenResp.ok) {
                throw new Error('Failed to exchange Google OAuth code.');
            }
            const tokenData = await tokenResp.json();

            const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (!userResp.ok) {
                throw new Error('Failed to fetch Google user profile.');
            }
            const googleUser = await userResp.json();

            const user = await queryOne(
                'SELECT * FROM users WHERE google_id = $1 OR email = $2 LIMIT 1',
                [String(googleUser.id), String(googleUser.email || '').toLowerCase()]
            );

            if (user) {
                if (String(user.role || '').trim().toLowerCase() === 'admin') {
                    req.flashErrors({ email: 'Administrator accounts must sign in via the Admin Portal.' });
                    return res.redirect('/resident/login');
                }

                if (!user.google_id) {
                    await query('UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2', [String(googleUser.id), user.id]);
                }

                const statusLower = String(user.status || '').trim().toLowerCase();
                if (statusLower === 'active') {
                    const intended = req.session.urlIntended || '/resident';
                    delete req.session.urlIntended;
                    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
                    req.session.userId = Number(user.id);
                    return res.redirect(intended);
                }

                if (statusLower === 'pending_approval') {
                    return res.redirect('/resident/pending-approval');
                }

                if (statusLower === 'incomplete') {
                    await query('DELETE FROM users WHERE id = $1', [user.id]);
                    req.session.google_reg_email = googleUser.email;
                    req.session.google_reg_name = googleUser.name;
                    req.session.google_reg_id = String(googleUser.id);
                    req.session.reg_verified_target = googleUser.email;
                    req.session.reg_verified_at = new Date().toISOString();
                    req.flash('via_google', true);
                    return res.redirect('/resident/register');
                }

                req.flashErrors({ email: 'Your account access has been revoked or denied.' });
                return res.redirect('/resident/login');
            }

            req.session.google_reg_email = googleUser.email;
            req.session.google_reg_name = googleUser.name;
            req.session.google_reg_id = String(googleUser.id);
            req.session.reg_verified_target = googleUser.email;
            req.session.reg_verified_at = new Date().toISOString();
            req.flash('via_google', true);
            return res.redirect('/resident/register');
        } catch (err) {
            console.warn('Google OAuth callback failed:', err.message);
            req.flashErrors({ email: 'Unable to complete Google sign-in. Please try again.' });
            return res.redirect('/resident/login');
        }
    });
}
