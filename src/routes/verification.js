import crypto from 'crypto';
import { env, getRequestBaseUrl } from '../config/env.js';
import { query, queryOne } from '../db/pool.js';
import { NotificationService } from '../lib/models.js';
import { cleanPhone } from '../lib/validators.js';
import { requireAuth, requireResident } from '../middleware/auth.js';
import { limit10PerMin, limit6PerMin } from '../middleware/rateLimit.js';
import { sendEmailVerificationLinkEmail } from '../services/mailService.js';

export function buildSignedVerificationUrl(user, baseUrl) {
    const emailHash = crypto.createHash('sha1').update(String(user.email || '')).digest('hex');
    const expires = Math.floor(Date.now() / 1000) + 3600; // 60 minutes
    const payload = `${user.id}|${emailHash}|${expires}`;
    const sig = crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('hex');
    return `${baseUrl}/email/verify/${user.id}/${emailHash}?expires=${expires}&signature=${sig}`;
}

export function registerVerificationRoutes(app) {
    // Email Verification Notice
    app.get('/email/verify', requireAuth('/resident/login'), requireResident, (req, res) => {
        req.routeName = 'verification.notice';
        res.locals.currentRoute = 'verification.notice';
        return res.render('resident/verify_email');
    });

    // Resend Verification Email
    app.post('/email/verification-notification', requireAuth('/resident/login'), requireResident, limit6PerMin, async (req, res) => {
        try {
            if (req.user?.email) {
                const url = buildSignedVerificationUrl(req.user, getRequestBaseUrl(req));
                await sendEmailVerificationLinkEmail(req.user.email, url);
            }
            return res.redirectWithFlash('/email/verify', 'success', 'A new verification link has been sent to your email address.');
        } catch (err) {
            console.error('Resend verification email failed:', err.message);
            return res.redirectWithFlash('/email/verify', 'success', 'Verification email request processed. Please check your inbox.');
        }
    });

    // Phone Verification Form
    app.get('/phone/verify', requireAuth('/resident/login'), requireResident, (req, res) => {
        req.routeName = 'verify_phone.notice';
        res.locals.currentRoute = 'verify_phone.notice';
        const phone = res.locals.sessionGet('phone_number') || req.user.phone_number;
        if (!phone) return res.redirect('/resident');
        return res.render('resident/auth/verify_phone', { phone });
    });

    // Phone Verification Submit
    app.post('/phone/verify', requireAuth('/resident/login'), requireResident, limit10PerMin, async (req, res) => {
        const rawCode = req.body?.code;
        if (!Array.isArray(rawCode) || rawCode.length !== 5) {
            return res.redirectBackWithErrors({ code: 'Please enter the 5-digit verification code.' }, false, '/phone/verify');
        }

        const boundPhone = cleanPhone(req.user.phone_number || '');
        if (!boundPhone) {
            return res.redirectBackWithErrors({ code: 'No mobile number is associated with your account.' }, false, '/phone/verify');
        }

        const codeString = rawCode.join('').trim();
        const record = await queryOne('SELECT * FROM password_reset_tokens WHERE email = $1 LIMIT 1', [boundPhone]);

        if (!record || record.token.length !== codeString.length || !crypto.timingSafeEqual(Buffer.from(record.token), Buffer.from(codeString))) {
            req.flash('phone_number', boundPhone);
            return res.redirectBackWithErrors({ code: 'The verification code you entered is incorrect.' }, false, '/phone/verify');
        }

        const expiresAt = new Date(record.created_at).getTime() + 15 * 60 * 1000;
        if (Date.now() > expiresAt) {
            await query('DELETE FROM password_reset_tokens WHERE email = $1', [boundPhone]);
            req.flash('phone_number', boundPhone);
            return res.redirectBackWithErrors({ code: 'This verification code has expired. Please request a new code.' }, false, '/phone/verify');
        }

        await query('DELETE FROM password_reset_tokens WHERE email = $1', [boundPhone]);
        await query('UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1', [req.user.id]);

        if (req.user.proof_of_residency) {
            await query("UPDATE users SET status = 'pending_approval', updated_at = NOW() WHERE id = $1", [req.user.id]);
            await NotificationService.notifyAdmins('App\\Notifications\\NewUserRegistrationNotification', {
                type: 'new_registration',
                user_id: req.user.id,
                name: req.user.name,
                message: `New resident registration pending approval: ${req.user.name}.`,
                link: '/admin/account-approvals',
            });
            await new Promise((resolve) => req.session.destroy(() => resolve()));
            return res.redirect('/resident/pending-approval?notify=phone');
        }

        return res.redirect('/complete-registration');
    });

    // Verification Link Handler
    app.get('/email/verify/:id/:hash', limit10PerMin, async (req, res) => {
        const { id, hash } = req.params;
        const { expires, signature } = req.query;

        const user = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
        if (!user) return res.status(404).send('User not found.');

        const expectedHash = crypto.createHash('sha1').update(String(user.email || '')).digest('hex');
        if (!hash || hash.length !== expectedHash.length || !crypto.timingSafeEqual(Buffer.from(String(hash)), Buffer.from(expectedHash))) {
            return res.status(403).send('Invalid or expired verification link.');
        }

        // Verify signed query parameters
        const expNum = Number(expires || 0);
        if (!expNum || Math.floor(Date.now() / 1000) > expNum || !signature) {
            return res.status(403).send('Invalid or expired verification link.');
        }
        const expectedSig = crypto
            .createHmac('sha256', env.sessionSecret)
            .update(`${user.id}|${expectedHash}|${expNum}`)
            .digest('hex');
        if (String(signature).length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(String(signature)), Buffer.from(expectedSig))) {
            return res.status(403).send('Invalid or expired verification link.');
        }

        const normalizedStatus = String(user.status || '').trim().toLowerCase();
        if (['rejected', 'deactivated', 'inactive'].includes(normalizedStatus)) {
            req.flashErrors({
                email: 'Your account is not eligible for login. Please contact the barangay office.',
            });
            return res.redirect('/resident/login');
        }

        if (!user.email_verified_at) {
            await query('UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
        }

        if (normalizedStatus === 'incomplete') {
            if (user.proof_of_residency) {
                await query("UPDATE users SET status = 'pending_approval', updated_at = NOW() WHERE id = $1", [user.id]);
                await NotificationService.notifyAdmins('App\\Notifications\\NewUserRegistrationNotification', {
                    type: 'new_registration',
                    user_id: user.id,
                    name: user.name,
                    message: `New resident registration pending approval: ${user.name}.`,
                    link: '/admin/account-approvals',
                });
                const notifyMethod = !user.email ? 'phone' : 'email';
                return res.redirect(`/resident/pending-approval?notify=${notifyMethod}`);
            }

            await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
            req.session.userId = Number(user.id);
            return res.redirect('/complete-registration');
        }

        if (normalizedStatus === 'pending_approval') {
            return res.redirect('/resident/pending-approval');
        }

        if (normalizedStatus === 'active') {
            await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
            req.session.userId = Number(user.id);
            return res.redirect('/resident');
        }

        return res.redirect('/resident/login');
    });
}
