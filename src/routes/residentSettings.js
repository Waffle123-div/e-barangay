import crypto from 'crypto';
import { query, queryOne } from '../db/pool.js';
import { ActivityLog } from '../lib/models.js';
import { hashSecret, verifySecret } from '../lib/password.js';
import { requireAuth, requireResidentPin, requireVerified } from '../middleware/auth.js';
import { verifyMultipartCsrfAndMethod } from '../middleware/csrf.js';
import { populateResidentLayoutLocals } from '../middleware/layoutLocals.js';
import { limit10PerMin, limit5PerMin } from '../middleware/rateLimit.js';
import { uploadImage2MB, uploadValidId5MB } from '../middleware/upload.js';
import { sendRegistrationOtpEmail } from '../services/mailService.js';
import { sendSms } from '../services/smsService.js';
import { deleteFile, serveFile, uploadBuffer } from '../services/storageService.js';

function settingsGuard(routeName) {
    return [
        (req, res, next) => {
            req.routeName = routeName;
            res.locals.currentRoute = routeName;
            next();
        },
        requireAuth('/resident/login'),
        requireVerified,
        requireResidentPin,
        populateResidentLayoutLocals,
    ];
}

function hasFreshSettingsOtp(req) {
    if (req.session?.settings_otp_verified !== true) return false;
    const verifiedAt = Number(req.session?.settings_otp_verified_at || 0);
    return verifiedAt > 0 && Math.floor(Date.now() / 1000) - verifiedAt <= 900;
}

export function registerResidentSettingsRoutes(app) {
    app.get('/resident/settings', ...settingsGuard('resident.settings'), async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') {
            return res.redirect('/resident/pending-approval');
        }

        const user = req.user;
        let sessions = [];
        try {
            const { rows } = await query('SELECT * FROM sessions WHERE user_id = $1 ORDER BY last_activity DESC', [user.id]);
            sessions = rows.map((s) => {
                const ua = String(s.user_agent || '').toLowerCase();
                let browser = 'Unknown';
                if (ua.includes('chrome')) browser = 'Chrome';
                else if (ua.includes('firefox')) browser = 'Firefox';
                else if (ua.includes('safari')) browser = 'Safari';
                else if (ua.includes('edge')) browser = 'Edge';
                return {
                    ...s,
                    last_active_at: new Date(Number(s.last_activity) * 1000),
                    is_current: s.id === req.sessionID,
                    device: ua.includes('mobile') ? 'Mobile' : 'Desktop',
                    browser,
                };
            });
        } catch (_) {}

        const { rows: activityLogs } = await query(
            'SELECT * FROM activity_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
            [user.id]
        );

        const activeTab = String(req.query.tab || res.locals.sessionGet('active_tab') || 'profile');
        return res.render(
            'resident/settings',
            { user, sessions, activityLogs, activeTab },
            (err, html) => {
                if (err) throw err;
                return res.render('resident/layouts/resident', { user, sessions, activityLogs, activeTab, body: html });
            }
        );
    });

    app.get('/resident/settings/file/:type/:filename?', ...settingsGuard('resident.settings.file'), async (req, res) => {
        const type = req.params.type;
        const map = {
            profile_picture: { path: req.user.profile_picture, hints: ['profile_pictures'] },
            id_photo: { path: req.user.id_photo, hints: ['valid_ids'] },
        };
        if (!map[type]) return res.status(404).send('File not found.');
        return serveFile(res, map[type].path, { directoryHints: map[type].hints, notFoundMessage: 'File not found.' });
    });

    app.post('/resident/settings/send-otp', ...settingsGuard('resident.settings.send_otp'), limit5PerMin, async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') {
            return res.status(403).json({ success: false, message: 'Unauthorized account status.' });
        }

        const user = req.user;
        const channel = req.body?.channel || 'email';
        const otpCode = String(crypto.randomInt(10000, 100000));

        req.session.settings_otp_hash = await hashSecret(otpCode);
        req.session.settings_otp_expires_at = Date.now() + 10 * 60 * 1000;
        req.session.settings_otp_channel = channel;
        req.session.settings_otp_attempts = 0;
        delete req.session.settings_otp_verified;
        delete req.session.settings_otp_verified_at;

        if (channel === 'email') {
            if (!user.email) {
                return res.status(400).json({ success: false, message: 'No email address registered on your account.' });
            }
            try {
                await sendRegistrationOtpEmail(user.email, otpCode, user.first_name || user.name || 'Resident');
            } catch (err) {
                console.error('Settings OTP Email Failed:', err.message);
            }
            return res.json({ success: true, message: 'Verification code sent to your email address.' });
        }

        if (channel === 'phone') {
            if (!user.phone_number) {
                return res.status(400).json({ success: false, message: 'No mobile number registered on your account.' });
            }
            await sendSms(user.phone_number, `E-Barangay: ${otpCode} is your security verification code. Valid for 10 minutes.`);
            return res.json({ success: true, message: 'Verification code sent to your mobile phone number via SMS.' });
        }

        return res.status(400).json({ success: false, message: 'Invalid verification channel selected.' });
    });

    app.post('/resident/settings/verify-otp', ...settingsGuard('resident.settings.verify_otp'), limit10PerMin, async (req, res) => {
        const inputCode = String(req.body?.code || '').trim();
        const sessionHash = req.session?.settings_otp_hash;
        const expiresAt = Number(req.session?.settings_otp_expires_at || 0);
        const attempts = Number(req.session?.settings_otp_attempts || 0);

        if (!sessionHash || !expiresAt || Date.now() > expiresAt) {
            delete req.session.settings_otp_hash;
            delete req.session.settings_otp_expires_at;
            delete req.session.settings_otp_attempts;
            return res.status(400).json({ success: false, message: 'The verification code has expired. Please request a new one.' });
        }

        if (attempts >= 5) {
            delete req.session.settings_otp_hash;
            delete req.session.settings_otp_expires_at;
            delete req.session.settings_otp_attempts;
            return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new verification code.' });
        }

        if (!inputCode || !(await verifySecret(inputCode, sessionHash))) {
            req.session.settings_otp_attempts = attempts + 1;
            return res.status(400).json({ success: false, message: 'Incorrect verification code. Please check and try again.' });
        }

        req.session.settings_otp_verified = true;
        req.session.settings_otp_verified_at = Math.floor(Date.now() / 1000);
        delete req.session.settings_otp_hash;
        delete req.session.settings_otp_expires_at;
        delete req.session.settings_otp_attempts;

        return res.json({ success: true, message: 'Security verification successful.' });
    });

    app.post(
        '/resident/settings/profile',
        ...settingsGuard('resident.settings.profile'),
        uploadImage2MB.single('profile_picture'),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
            const b = req.body || {};
            if (!b.first_name || !b.last_name) {
                return res.redirectBackWithErrors({ first_name: 'First name and last name are required.' }, b, '/resident/settings?tab=profile');
            }

            const firstName = String(b.first_name).trim().toUpperCase();
            const middleName = b.middle_name && String(b.middle_name).trim() ? String(b.middle_name).trim().toUpperCase() : null;
            const lastName = String(b.last_name).trim().toUpperCase();
            const suffix = b.suffix && String(b.suffix).trim() ? String(b.suffix).trim().toUpperCase() : null;
            const fullName = [firstName, middleName, lastName, suffix].filter(Boolean).join(' ');

            let profilePicture = req.user.profile_picture;
            if (req.file) {
                if (req.user.profile_picture) await deleteFile(req.user.profile_picture, ['profile_pictures']);
                profilePicture = await uploadBuffer(req.file.buffer, 'profile_pictures', req.file.originalname, req.file.mimetype);
            }

            await query(
                `UPDATE users SET
                    first_name = $1, middle_name = $2, last_name = $3, suffix = $4, name = $5,
                    birthdate = $6, age = $7, birthplace = $8, gender = $9, civil_status = $10,
                    nationality = $11, occupation = $12, phone_number = $13, house_number = $14,
                    street = $15, barangay_address = $16, municipality = $17, province = $18,
                    zip_code = $19, profile_picture = $20, updated_at = NOW()
                 WHERE id = $21`,
                [
                    firstName,
                    middleName,
                    lastName,
                    suffix,
                    fullName,
                    b.birthdate || null,
                    b.age ? Number(b.age) : null,
                    b.birthplace ? String(b.birthplace).trim().toUpperCase() : null,
                    b.gender || null,
                    b.civil_status || null,
                    b.nationality ? String(b.nationality).trim().toUpperCase() : null,
                    b.occupation ? String(b.occupation).trim().toUpperCase() : null,
                    b.phone_number || null,
                    b.house_number ? String(b.house_number).trim().toUpperCase() : null,
                    b.street ? String(b.street).trim().toUpperCase() : null,
                    b.barangay_address ? String(b.barangay_address).trim().toUpperCase() : null,
                    b.municipality ? String(b.municipality).trim().toUpperCase() : null,
                    b.province ? String(b.province).trim().toUpperCase() : null,
                    b.zip_code || null,
                    profilePicture,
                    req.user.id,
                ]
            );

            await ActivityLog.record('Profile Updated', 'Personal information and address were updated.', req.user.id, req);
            return res.redirectWithFlash('/resident/settings?tab=profile', 'success', 'Profile updated successfully!');
        }
    );

    app.post('/resident/settings/account', ...settingsGuard('resident.settings.account'), async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
        const b = req.body || {};
        const user = req.user;
        const changes = [];
        let newUsername = user.username;
        let newEmail = user.email;
        let emailVerifiedAt = user.email_verified_at;

        if (b.username && String(b.username).trim() !== '') {
            const uname = String(b.username).trim();
            if (!/^[a-zA-Z0-9_-]+$/.test(uname)) {
                return res.redirectBackWithErrors({ username: 'Username may only contain letters, numbers, dashes, and underscores.' }, b, '/resident/settings?tab=account');
            }
            const dup = await queryOne('SELECT id FROM users WHERE username = $1 AND id != $2 LIMIT 1', [uname, user.id]);
            if (dup) {
                return res.redirectBackWithErrors({ username: 'This username is already taken.' }, b, '/resident/settings?tab=account');
            }
            newUsername = uname;
            changes.push('username');
        }

        if (b.email && String(b.email).trim() !== '' && String(b.email).trim() !== user.email) {
            const em = String(b.email).trim();
            const dup = await queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2 LIMIT 1', [em, user.id]);
            if (dup) {
                return res.redirectBackWithErrors({ email: 'This email address is already registered.' }, b, '/resident/settings?tab=account');
            }
            newEmail = em;
            emailVerifiedAt = null;
            changes.push('email');
        }

        await query('UPDATE users SET username = $1, email = $2, email_verified_at = $3, updated_at = NOW() WHERE id = $4', [
            newUsername,
            newEmail,
            emailVerifiedAt,
            user.id,
        ]);

        if (changes.length > 0) {
            await ActivityLog.record('Account Updated', `Changed: ${changes.join(', ')}.`, user.id, req);
        }

        if (changes.includes('email')) {
            return res.redirectWithFlash('/email/verify', 'info', 'Email updated. Please verify your new email address.');
        }
        return res.redirectWithFlash('/resident/settings?tab=account', 'success', 'Account settings saved.');
    });

    app.post('/resident/settings/password', ...settingsGuard('resident.settings.password'), async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
        if (!hasFreshSettingsOtp(req)) {
            req.flash('active_tab', 'account');
            return res.redirectBackWithErrors({ otp: 'Please complete OTP verification before changing your password.' }, false, '/resident/settings?tab=account');
        }

        const currentPassword = String(req.body?.current_password || '');
        const password = String(req.body?.password || '');
        const passwordConf = String(req.body?.password_confirmation || '');

        if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || password !== passwordConf) {
            req.flash('active_tab', 'account');
            return res.redirectBackWithErrors(
                { password: 'Password must be at least 8 characters with uppercase, lowercase, and a number, and match confirmation.' },
                false,
                '/resident/settings?tab=account'
            );
        }

        if (!(await verifySecret(currentPassword, req.user.password))) {
            req.flash('active_tab', 'account');
            return res.redirectBackWithErrors({ current_password: 'Your current password is incorrect.' }, false, '/resident/settings?tab=account');
        }

        const hashed = await hashSecret(password);
        await query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, req.user.id]);
        delete req.session.settings_otp_verified;
        delete req.session.settings_otp_verified_at;

        await ActivityLog.record('Password Changed', 'Account password was successfully changed.', req.user.id, req);
        return res.redirectWithFlash('/resident/settings?tab=account', 'success', 'Password changed successfully!');
    });

    app.post('/resident/settings/security', ...settingsGuard('resident.settings.security'), async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
        const enable = Boolean(req.body?.two_factor_enabled && req.body.two_factor_enabled !== '0' && req.body.two_factor_enabled !== 'false');
        await query('UPDATE users SET two_factor_enabled = $1, updated_at = NOW() WHERE id = $2', [enable, req.user.id]);
        await ActivityLog.record('Security Settings Updated', `Two-Factor Authentication was ${enable ? 'enabled' : 'disabled'}.`, req.user.id, req);
        return res.redirectWithFlash('/resident/settings?tab=security', 'success', `2FA ${enable ? 'enabled' : 'disabled'} successfully.`);
    });

    app.post(
        '/resident/settings/id',
        ...settingsGuard('resident.settings.id'),
        uploadValidId5MB.single('id_photo'),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
            if (!hasFreshSettingsOtp(req)) {
                req.flash('active_tab', 'ids');
                return res.redirectBackWithErrors({ otp: 'Please complete OTP verification before uploading or replacing your valid ID.' }, false, '/resident/settings?tab=ids');
            }

            const allowedTypes = ['National ID', "Driver's License", 'Passport', 'PhilHealth', 'UMID', "Voter's ID"];
            const idType = req.body?.id_type;
            if (!idType || !allowedTypes.includes(idType) || !req.file) {
                req.flash('active_tab', 'ids');
                return res.redirectBackWithErrors({ id_photo: 'Please choose a valid ID type and upload a valid file.' }, false, '/resident/settings?tab=ids');
            }

            if (req.user.id_photo) await deleteFile(req.user.id_photo, ['valid_ids']);
            const filePath = await uploadBuffer(req.file.buffer, 'valid_ids', req.file.originalname, req.file.mimetype);

            await query(
                `UPDATE users
                 SET id_type = $1, id_photo = $2, id_expiry_date = $3, id_uploaded_at = NOW(), id_verified_at = NULL, updated_at = NOW()
                 WHERE id = $4`,
                [idType, filePath, req.body?.id_expiry_date || null, req.user.id]
            );

            delete req.session.settings_otp_verified;
            delete req.session.settings_otp_verified_at;
            await ActivityLog.record('ID Uploaded', `Uploaded ${idType} as valid ID.`, req.user.id, req);
            return res.redirectWithFlash('/resident/settings?tab=ids', 'success', 'Valid ID uploaded successfully. Please wait for admin verification.');
        }
    );

    app.post('/resident/settings/logout-others', ...settingsGuard('resident.settings.logout-others'), async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
        const pw = String(req.body?.current_password_sessions || '');
        if (!(await verifySecret(pw, req.user.password))) {
            req.flash('active_tab', 'security');
            return res.redirectBackWithErrors({ current_password_sessions: 'Password is incorrect.' }, false, '/resident/settings?tab=security');
        }
        await query('DELETE FROM sessions WHERE user_id = $1 AND id != $2', [req.user.id, req.sessionID]);
        await ActivityLog.record('Logout Other Devices', 'All other active sessions were terminated.', req.user.id, req);
        return res.redirectWithFlash('/resident/settings?tab=security', 'success', 'All other devices have been logged out.');
    });

    app.post('/resident/settings/logout-all', ...settingsGuard('resident.settings.logout-all'), async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
        const pw = String(req.body?.current_password_all || '');
        if (!(await verifySecret(pw, req.user.password))) {
            req.flash('active_tab', 'security');
            return res.redirectBackWithErrors({ current_password_all: 'Password is incorrect.' }, false, '/resident/settings?tab=security');
        }

        await ActivityLog.record('Logout All Devices', 'All sessions including current device were terminated.', req.user.id, req);
        try { await query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]); } catch (_) {}
        await new Promise((resolve) => req.session.destroy(() => resolve()));
        res.clearCookie('ebarangay_session');
        return res.redirectWithFlash('/resident/login', 'success', 'You have been logged out from all devices.');
    });

    app.post('/resident/settings/deactivate', ...settingsGuard('resident.settings.deactivate'), async (req, res) => {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
        if (req.body?.confirm_deactivate !== 'DEACTIVATE') {
            return res.redirectBackWithErrors({ confirm_deactivate: 'Please type DEACTIVATE to confirm.' }, false, '/resident/settings?tab=manage');
        }
        await ActivityLog.record('Account Deactivated', 'Resident requested account deactivation.', req.user.id, req);
        await query("UPDATE users SET status = 'deactivated', updated_at = NOW() WHERE id = $1", [req.user.id]);
        await new Promise((resolve) => req.session.destroy(() => resolve()));
        res.clearCookie('ebarangay_session');
        return res.redirectWithFlash('/resident/login', 'info', 'Your account has been deactivated. Contact the barangay office to reactivate.');
    });

    async function handleDeleteAccount(req, res) {
        if (String(req.user.status || '').trim().toLowerCase() !== 'active') return res.redirect('/resident/pending-approval');
        if (req.body?.confirm_delete !== 'DELETE') {
            req.flash('active_tab', 'manage');
            return res.redirectBackWithErrors({ confirm_delete: 'Please type DELETE to confirm.' }, false, '/resident/settings?tab=manage');
        }
        const pw = String(req.body?.password_delete || '');
        if (!(await verifySecret(pw, req.user.password))) {
            req.flash('active_tab', 'manage');
            return res.redirectBackWithErrors({ password_delete: 'Password is incorrect.' }, false, '/resident/settings?tab=manage');
        }

        const user = req.user;
        if (user.profile_picture) await deleteFile(user.profile_picture, ['profile_pictures']);
        if (user.id_photo) await deleteFile(user.id_photo, ['valid_ids']);

        await query('DELETE FROM users WHERE id = $1', [user.id]);
        await new Promise((resolve) => req.session.destroy(() => resolve()));
        res.clearCookie('ebarangay_session');
        return res.redirectWithFlash('/resident/login', 'info', 'Your account has been permanently deleted.');
    }

    app.delete('/resident/settings/delete', ...settingsGuard('resident.settings.delete'), handleDeleteAccount);
    app.post('/resident/settings/delete', ...settingsGuard('resident.settings.delete'), handleDeleteAccount);
}
