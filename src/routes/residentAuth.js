import crypto from 'crypto';
import { query, queryOne } from '../db/pool.js';
import { NotificationService } from '../lib/models.js';
import { hashSecret, verifySecret } from '../lib/password.js';
import {
    cleanPhone,
    decodeBase64Image,
    isValidEmail,
    maskPhoneDisplay,
    sanitizeIntendedUrl,
} from '../lib/validators.js';
import { requireAuth, requireGuest, requireResident, requireVerified } from '../middleware/auth.js';
import { verifyMultipartCsrfAndMethod } from '../middleware/csrf.js';
import { limit10PerMin, limit5PerMin } from '../middleware/rateLimit.js';
import { uploadRegistrationFiles } from '../middleware/upload.js';
import { sendPasswordChangedEmail, sendRegistrationOtpEmail, sendResetPasswordCodeEmail } from '../services/mailService.js';
import { verifyRecaptchaToken } from '../services/recaptchaService.js';
import { sendSms } from '../services/smsService.js';
import { deleteFile, putBuffer, uploadBuffer } from '../services/storageService.js';

function smartRedirectPath(user, intended = null) {
    const status = String(user.status || '').trim().toLowerCase();
    if (status === 'active') return intended || '/resident';
    if (status === 'pending_approval') return '/resident/pending-approval';
    if (status === 'incomplete') {
        return user.email_verified_at ? '/complete-registration' : '/email/verify';
    }
    return null;
}

async function findNonRejectedByContact(column, value) {
    if (!value) return null;
    if (column === 'email') {
        return queryOne("SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND LOWER(COALESCE(status, '')) != 'rejected' LIMIT 1", [value]);
    }
    return queryOne(`SELECT * FROM users WHERE ${column} = $1 AND LOWER(COALESCE(status, '')) != 'rejected' LIMIT 1`, [value]);
}

async function findRejectedByContact(column, value) {
    if (!value) return null;
    if (column === 'email') {
        return queryOne("SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND LOWER(COALESCE(status, '')) = 'rejected' LIMIT 1", [value]);
    }
    return queryOne(`SELECT * FROM users WHERE ${column} = $1 AND LOWER(COALESCE(status, '')) = 'rejected' LIMIT 1`, [value]);
}

export function registerResidentAuthRoutes(app) {
    // Login form
    app.get('/resident/login', requireGuest, (req, res) => {
        req.routeName = 'resident.login';
        res.locals.currentRoute = 'resident.login';
        return res.render('resident/auth/login');
    });

    // Login submit
    app.post('/resident/login', requireGuest, limit10PerMin, async (req, res) => {
        const wantsJson = req.xhr || req.headers.accept?.includes('application/json');
        const loginInputRaw = String(req.body?.email || '').trim();
        const password = String(req.body?.password || '');

        if (!loginInputRaw || !password) {
            if (wantsJson) return res.status(422).json({ success: false, message: 'Email/phone and password are required.' });
            return res.redirectBackWithErrors({ email: 'Email/phone and password are required.' }, { email: loginInputRaw }, '/resident/login');
        }

        const recaptchaToken = req.body?.['g-recaptcha-response'];
        const recaptchaOk = await verifyRecaptchaToken(recaptchaToken);
        if (!recaptchaOk) {
            const msg = 'Please complete the reCAPTCHA verification.';
            if (wantsJson) return res.status(422).json({ success: false, message: msg, errors: { 'g-recaptcha-response': [msg] } });
            return res.redirectBackWithErrors({ 'g-recaptcha-response': msg }, { email: loginInputRaw }, '/resident/login');
        }

        const isEmail = isValidEmail(loginInputRaw);
        const lookupValue = isEmail ? loginInputRaw : cleanPhone(loginInputRaw);
        const user = isEmail
            ? await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [lookupValue])
            : await queryOne('SELECT * FROM users WHERE phone_number = $1 LIMIT 1', [lookupValue]);

        if (!user || !(await verifySecret(password, user.password))) {
            const msg = 'The provided credentials do not match our records.';
            if (wantsJson) return res.status(422).json({ success: false, message: msg });
            return res.redirectBackWithErrors({ email: msg }, { email: loginInputRaw }, '/resident/login');
        }

        const safeIntended = sanitizeIntendedUrl(req.body?.intended);
        await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
        req.session.userId = Number(user.id);

        if (String(user.role || '').trim().toLowerCase() === 'admin') {
            if (wantsJson) return res.json({ success: true, redirect: '/admin' });
            return res.redirect('/admin');
        }

        const targetUrl = smartRedirectPath(user, safeIntended || req.session.urlIntended);
        delete req.session.urlIntended;

        if (!targetUrl) {
            await new Promise((resolve) => req.session.destroy(() => resolve()));
            const msg = 'Your account access has been revoked or denied.';
            if (wantsJson) return res.status(422).json({ success: false, message: msg });
            return res.redirectBackWithErrors({ email: msg }, false, '/resident/login');
        }

        if (wantsJson) return res.json({ success: true, redirect: targetUrl });
        return res.redirect(targetUrl);
    });

    // Forgot Password flow
    app.get('/resident/forgot-password', requireGuest, (req, res) => {
        req.routeName = 'resident.forgot_password';
        return res.render('resident/auth/forgot_password');
    });

    app.post('/resident/forgot-password/search', requireGuest, limit10PerMin, async (req, res) => {
        const loginInputRaw = String(req.body?.login_id || '').trim();
        if (!loginInputRaw) {
            return res.redirectBackWithErrors({ login_id: 'Please enter your email or mobile number.' }, req.body, '/resident/forgot-password');
        }

        const recaptchaOk = await verifyRecaptchaToken(req.body?.['g-recaptcha-response']);
        if (!recaptchaOk) {
            return res.redirectBackWithErrors({ 'g-recaptcha-response': 'Please complete the CAPTCHA to prove you are a human.' }, req.body, '/resident/forgot-password');
        }

        const isEmail = isValidEmail(loginInputRaw);
        const identifier = isEmail ? loginInputRaw : cleanPhone(loginInputRaw);
        const user = isEmail
            ? await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [identifier])
            : await queryOne('SELECT * FROM users WHERE phone_number = $1 LIMIT 1', [identifier]);

        if (!user) {
            return res.redirectBackWithErrors({ login_id: 'We could not find an account matching that information. Please try again.' }, req.body, '/resident/forgot-password');
        }

        if (String(user.status || '').trim().toLowerCase() !== 'active') {
            return res.redirectBackWithErrors({ login_id: 'Your account has not been approved by the admin yet. Password recovery is only available for fully active accounts.' }, req.body, '/resident/forgot-password');
        }

        return res.render('resident/auth/forgot_password_confirm', { user, identifier });
    });

    app.post('/resident/forgot-password/send', requireGuest, limit5PerMin, async (req, res) => {
        const rawIdentifier = String(req.body?.email || '').trim();
        if (!rawIdentifier) return res.redirect('/resident/forgot-password');

        const isEmail = isValidEmail(rawIdentifier);
        const identifier = isEmail ? rawIdentifier : cleanPhone(rawIdentifier);
        const user = isEmail
            ? await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [identifier])
            : await queryOne('SELECT * FROM users WHERE phone_number = $1 LIMIT 1', [identifier]);

        if (!user || String(user.role || '').trim().toLowerCase() === 'admin' || String(user.status || '').trim().toLowerCase() !== 'active') {
            return res.redirectBackWithErrors({ login_id: 'Invalid recovery request.' }, false, '/resident/forgot-password');
        }

        const code = String(crypto.randomInt(0, 100000)).padStart(5, '0');
        const hashedCode = await hashSecret(code);
        await query(
            `INSERT INTO password_reset_tokens (email, token, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (email) DO UPDATE SET token = EXCLUDED.token, created_at = NOW()`,
            [identifier, hashedCode]
        );

        req.session.reset_email = identifier;
        req.session.reset_code_attempts = 0;

        if (isEmail) {
            try {
                await sendResetPasswordCodeEmail(identifier, code, user.name);
            } catch (err) {
                console.error('Reset email error:', err.message);
            }
        } else {
            await sendSms(identifier, `E-Barangay: ${code} is your password reset code. Please do not share this with anyone.`);
        }

        req.flash('reset_email', identifier);
        return res.redirect('/resident/forgot-password/verify');
    });

    app.get('/resident/forgot-password/verify', requireGuest, (req, res) => {
        const email = req.session?.reset_email || res.locals.sessionGet('reset_email');
        if (!email) return res.redirect('/resident/forgot-password');
        return res.render('resident/auth/verify_reset_code', { email });
    });

    app.post('/resident/forgot-password/verify', requireGuest, limit10PerMin, async (req, res) => {
        let identifier = String(req.body?.email || '').trim();
        const rawCode = req.body?.code;
        if (!identifier || !Array.isArray(rawCode) || rawCode.length !== 5) {
            return res.redirectBackWithErrors({ code: 'Please enter a valid 5-digit verification code.' }, false, '/resident/forgot-password/verify');
        }
        if (!isValidEmail(identifier)) identifier = cleanPhone(identifier) || '';

        if (req.session.reset_email && req.session.reset_email !== identifier) {
            return res.redirectBackWithErrors({ login_id: 'Password reset session mismatch. Please start again.' }, false, '/resident/forgot-password');
        }

        const attempts = Number(req.session.reset_code_attempts || 0);
        if (attempts >= 5) {
            await query('DELETE FROM password_reset_tokens WHERE email = $1', [identifier]);
            delete req.session.reset_email;
            delete req.session.reset_code_attempts;
            req.flashErrors({ login_id: 'Too many incorrect code attempts. Please request a new reset code.' });
            return res.redirect('/resident/forgot-password');
        }

        const codeString = rawCode.join('').toUpperCase().trim();
        const record = await queryOne('SELECT * FROM password_reset_tokens WHERE email = $1 LIMIT 1', [identifier]);
        if (!record) {
            req.session.reset_code_attempts = attempts + 1;
            req.flash('reset_email', identifier);
            return res.redirectBackWithErrors({ code: 'The verification code you entered is incorrect or expired.' }, false, '/resident/forgot-password/verify');
        }

        if (Date.now() > new Date(record.created_at).getTime() + 15 * 60 * 1000) {
            await query('DELETE FROM password_reset_tokens WHERE email = $1', [identifier]);
            delete req.session.reset_email;
            delete req.session.reset_code_attempts;
            req.flashErrors({ login_id: 'Your password reset code has expired. Please request a new code.' });
            return res.redirect('/resident/forgot-password');
        }

        const isHashed = /^\$(2y|2b|2a)\$/.test(record.token);
        const valid = isHashed
            ? await verifySecret(codeString, record.token)
            : record.token.length === codeString.length && crypto.timingSafeEqual(Buffer.from(record.token), Buffer.from(codeString));

        if (!valid) {
            const nextAttempts = attempts + 1;
            req.session.reset_code_attempts = nextAttempts;
            if (nextAttempts >= 5) {
                await query('DELETE FROM password_reset_tokens WHERE email = $1', [identifier]);
                delete req.session.reset_email;
                delete req.session.reset_code_attempts;
                req.flashErrors({ login_id: 'Too many incorrect code attempts. Please request a new reset code.' });
                return res.redirect('/resident/forgot-password');
            }
            req.flash('reset_email', identifier);
            return res.redirectBackWithErrors({ code: 'The verification code you entered is incorrect.' }, false, '/resident/forgot-password/verify');
        }

        await query('DELETE FROM password_reset_tokens WHERE email = $1', [identifier]);
        const resetAuthToken = crypto.randomBytes(32).toString('hex');
        req.session.password_reset_verified_email = identifier;
        req.session.password_reset_token = resetAuthToken;
        req.session.password_reset_expires_at = Math.floor(Date.now() / 1000) + 900;
        delete req.session.reset_email;
        delete req.session.reset_code_attempts;

        req.flash('verified_email', identifier);
        return res.redirect('/resident/forgot-password/reset');
    });

    app.get('/resident/forgot-password/reset', requireGuest, async (req, res) => {
        const identifier = req.session?.password_reset_verified_email;
        const resetToken = req.session?.password_reset_token;
        const expiresAt = Number(req.session?.password_reset_expires_at || 0);

        if (!identifier || !resetToken || expiresAt < Math.floor(Date.now() / 1000)) {
            delete req.session.password_reset_verified_email;
            delete req.session.password_reset_token;
            delete req.session.password_reset_expires_at;
            req.flashErrors({ login_id: 'Your password reset session has expired. Please request a new code.' });
            return res.redirect('/resident/forgot-password');
        }

        const isEmail = isValidEmail(identifier);
        const user = isEmail
            ? await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [identifier])
            : await queryOne('SELECT * FROM users WHERE phone_number = $1 LIMIT 1', [identifier]);

        if (!user || String(user.role || '').trim().toLowerCase() === 'admin' || String(user.status || '').trim().toLowerCase() !== 'active') {
            delete req.session.password_reset_verified_email;
            delete req.session.password_reset_token;
            delete req.session.password_reset_expires_at;
            return res.redirect('/resident/login');
        }

        return res.render('resident/auth/reset_password', { user, verified_email: identifier });
    });

    app.post('/resident/forgot-password/reset', requireGuest, limit5PerMin, async (req, res) => {
        const password = String(req.body?.password || '');
        const passwordConfirmation = String(req.body?.password_confirmation || '');
        const postedToken = String(req.body?.reset_token || '');
        let identifier = String(req.body?.email || '').trim();
        if (!isValidEmail(identifier)) identifier = cleanPhone(identifier) || '';

        if (password.length < 8 || password !== passwordConfirmation) {
            return res.redirectBackWithErrors({ password: 'Password must be at least 8 characters and match confirmation.' }, false, '/resident/forgot-password/reset');
        }

        const sessionIdentifier = String(req.session?.password_reset_verified_email || '');
        const sessionToken = String(req.session?.password_reset_token || '');
        const expiresAt = Number(req.session?.password_reset_expires_at || 0);

        const idMatch = sessionIdentifier.length === identifier.length && sessionIdentifier.length > 0 && crypto.timingSafeEqual(Buffer.from(sessionIdentifier), Buffer.from(identifier));
        const tokMatch = sessionToken.length === postedToken.length && sessionToken.length > 0 && crypto.timingSafeEqual(Buffer.from(sessionToken), Buffer.from(postedToken));

        if (!idMatch || !tokMatch || expiresAt < Math.floor(Date.now() / 1000)) {
            delete req.session.password_reset_verified_email;
            delete req.session.password_reset_token;
            delete req.session.password_reset_expires_at;
            req.flashErrors({ login_id: 'Unauthorized or expired password reset session. Please verify your code again.' });
            return res.redirect('/resident/forgot-password');
        }

        const isEmail = isValidEmail(sessionIdentifier);
        const user = isEmail
            ? await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [sessionIdentifier])
            : await queryOne('SELECT * FROM users WHERE phone_number = $1 LIMIT 1', [sessionIdentifier]);

        if (!user || String(user.role || '').trim().toLowerCase() === 'admin' || String(user.status || '').trim().toLowerCase() !== 'active') {
            delete req.session.password_reset_verified_email;
            delete req.session.password_reset_token;
            delete req.session.password_reset_expires_at;
            req.flashErrors({ email: 'Unable to reset password for this account.' });
            return res.redirect('/resident/login');
        }

        const hashed = await hashSecret(password);
        await query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, user.id]);
        await query('DELETE FROM password_reset_tokens WHERE email = $1', [sessionIdentifier]);
        await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);

        delete req.session.password_reset_verified_email;
        delete req.session.password_reset_token;
        delete req.session.password_reset_expires_at;

        if (isEmail) {
            try { await sendPasswordChangedEmail(sessionIdentifier, user.name); } catch (_) {}
        } else {
            await sendSms(sessionIdentifier, 'E-Barangay: Your account password has been successfully changed.');
        }

        return res.redirect('/resident/forgot-password/success');
    });

    app.get('/resident/forgot-password/success', requireGuest, (req, res) => {
        return res.render('resident/auth/password_reset_success');
    });

    // Registration Routes
    app.get('/resident/register', (req, res) => {
        req.routeName = 'resident.register';
        res.locals.currentRoute = 'resident.register';
        return res.render('resident/auth/register');
    });

    app.post('/resident/register/send-otp', limit5PerMin, async (req, res) => {
        const email = req.body?.email ? String(req.body.email).trim() : null;
        const clean = req.body?.phone_number ? cleanPhone(req.body.phone_number) : null;
        const firstName = req.body?.first_name ? String(req.body.first_name).trim() : 'Resident';

        if (email && (await findNonRejectedByContact('email', email))) {
            return res.status(422).json({
                success: false,
                field: 'email',
                message: 'This email address is already registered. Please log in instead.',
            });
        }

        if (clean && (await findNonRejectedByContact('phone_number', clean))) {
            return res.status(422).json({
                success: false,
                field: 'phone_number',
                message: 'This mobile number is already registered. Please log in instead.',
            });
        }

        const targetType = req.body?.target_type || (email ? 'email' : 'phone');
        let target;
        if (targetType === 'email') {
            if (!email || !isValidEmail(email)) {
                return res.status(422).json({ success: false, message: 'Email address is required to verify via email.' });
            }
            target = email;
        } else {
            if (!clean) {
                return res.status(422).json({ success: false, message: 'Mobile number is required to verify via SMS.' });
            }
            target = clean;
        }

        const code = String(crypto.randomInt(0, 100000)).padStart(5, '0');
        await query(
            `INSERT INTO password_reset_tokens (email, token, created_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (email) DO UPDATE SET token = EXCLUDED.token, created_at = NOW()`,
            [target, code]
        );

        req.session.reg_verify_target = target;
        req.session.reg_verify_type = targetType;
        req.session.reg_verify_attempts = 0;

        if (targetType === 'email') {
            try {
                await sendRegistrationOtpEmail(target, code, firstName || 'Resident');
            } catch (err) {
                console.error('Registration OTP email delivery failed:', err.message);
                return res.status(422).json({
                    success: false,
                    message: 'Unable to send verification email right now. Please try again shortly or verify via SMS.',
                });
            }
        } else {
            await sendSms(target, `E-Barangay: ${code} is your verification code to continue registration. Valid for 15 minutes.`);
        }

        return res.json({
            success: true,
            message: 'Verification code sent successfully.',
            target,
            target_type: targetType,
            display_target: targetType === 'email' ? target : maskPhoneDisplay(target),
            csrf_token: res.locals.csrfToken,
        });
    });

    app.post('/resident/register/verify-otp', limit10PerMin, async (req, res) => {
        const rawCode = req.body?.code;
        const code = Array.isArray(rawCode) ? rawCode.join('').toUpperCase().trim() : String(rawCode || '').toUpperCase().trim();
        if (code.length !== 5) {
            return res.status(422).json({ success: false, message: 'Please enter a valid 5-digit verification code.' });
        }

        let target = req.body?.target || req.session?.reg_verify_target;
        if (!target) {
            return res.status(422).json({ success: false, message: 'No active verification session found. Please request a new code.' });
        }
        if (!isValidEmail(target)) target = cleanPhone(target) || '';

        const attempts = Number(req.session?.reg_verify_attempts || 0);
        if (attempts >= 5) {
            await query('DELETE FROM password_reset_tokens WHERE email = $1', [target]);
            delete req.session.reg_verify_attempts;
            return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new verification code.' });
        }

        const record = await queryOne('SELECT * FROM password_reset_tokens WHERE email = $1 LIMIT 1', [target]);
        if (!record || record.token.length !== code.length || !crypto.timingSafeEqual(Buffer.from(record.token), Buffer.from(code))) {
            req.session.reg_verify_attempts = attempts + 1;
            return res.status(422).json({ success: false, message: 'The verification code you entered is incorrect.' });
        }

        if (Date.now() > new Date(record.created_at).getTime() + 15 * 60 * 1000) {
            await query('DELETE FROM password_reset_tokens WHERE email = $1', [target]);
            delete req.session.reg_verify_attempts;
            return res.status(422).json({ success: false, message: 'This verification code has expired. Please request a new code.' });
        }

        await query('DELETE FROM password_reset_tokens WHERE email = $1', [target]);
        delete req.session.reg_verify_attempts;

        req.session.reg_verified_target = target;
        req.session.reg_verified_at = new Date().toISOString();

        return res.json({
            success: true,
            message: 'Identity verified successfully!',
            verified_target: target,
            csrf_token: res.locals.csrfToken,
        });
    });

    app.post(
        '/resident/register',
        limit10PerMin,
        uploadRegistrationFiles.fields([
            { name: 'proof_of_residency', maxCount: 1 },
            { name: 'selfie_photo', maxCount: 1 },
            { name: 'selfie_upload', maxCount: 1 },
        ]),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            const b = req.body || {};
            const files = req.files || {};
            const isGoogleSubmit = Boolean(req.session?.google_reg_id);

            const requiredFields = [
                'last_name', 'first_name', 'birthdate', 'age', 'birthplace',
                'gender', 'civil_status', 'nationality', 'occupation',
                'purok', 'barangay_address', 'municipality', 'zip_code', 'id_type',
            ];
            const errs = {};
            for (const f of requiredFields) {
                if (!b[f] || String(b[f]).trim() === '') errs[f] = [`The ${f.replace(/_/g, ' ')} field is required.`];
            }
            if (!b.terms) errs.terms = ['You must accept the terms and conditions.'];
            if (!b.privacy) errs.privacy = ['You must accept the privacy policy.'];

            const actualEmail = b.email ? String(b.email).trim() : null;
            const actualPhone = b.phone_number ? cleanPhone(b.phone_number) : null;
            if (!actualEmail && !actualPhone) {
                errs.email = ['Please provide either an email address or a mobile number.'];
            }
            if (actualEmail && !isValidEmail(actualEmail)) {
                errs.email = ['Please provide a valid email address.'];
            }
            if (!isGoogleSubmit) {
                if (!b.password || String(b.password).length < 8 || b.password !== b.password_confirmation) {
                    errs.password = ['Password must be at least 8 characters and match confirmation.'];
                }
            }
            if (!files.proof_of_residency?.[0]) {
                errs.proof_of_residency = ['Please upload a valid ID / proof of residency.'];
            }

            if (Object.keys(errs).length > 0) {
                return res.redirectBackWithErrors(errs, b, '/resident/register');
            }

            if (actualEmail && (await findNonRejectedByContact('email', actualEmail))) {
                return res.redirectBackWithErrors({ email: 'This email address is already registered.' }, b, '/resident/register');
            }
            if (actualPhone && (await findNonRejectedByContact('phone_number', actualPhone))) {
                return res.redirectBackWithErrors({ phone_number: 'This mobile number is already registered.' }, b, '/resident/register');
            }

            const googleId = req.session?.google_reg_id;
            const isGoogleUser = Boolean(googleId && req.session?.google_reg_email === actualEmail);

            if (!isGoogleUser) {
                const verifiedTarget = req.session?.reg_verified_target;
                const isPreVerified = Boolean(verifiedTarget && (verifiedTarget === actualEmail || verifiedTarget === actualPhone));
                if (!isPreVerified) {
                    return res.redirectBackWithErrors({ email: 'Please verify your email address or mobile number before proceeding.' }, b, '/resident/register');
                }
            }

            let imagePath = null;
            if (files.proof_of_residency?.[0]) {
                const file = files.proof_of_residency[0];
                imagePath = await uploadBuffer(file.buffer, 'residency_proofs', file.originalname, file.mimetype);
            }

            let selfiePath = null;
            if (files.selfie_upload?.[0]) {
                const file = files.selfie_upload[0];
                selfiePath = await uploadBuffer(file.buffer, 'selfies', file.originalname, file.mimetype);
            } else if (files.selfie_photo?.[0]) {
                const file = files.selfie_photo[0];
                selfiePath = await uploadBuffer(file.buffer, 'selfies', file.originalname, file.mimetype);
            } else if (b.selfie_photo && typeof b.selfie_photo === 'string' && b.selfie_photo.trim() !== '') {
                const decoded = decodeBase64Image(b.selfie_photo);
                if (!decoded) {
                    return res.redirectBackWithErrors({ selfie_photo: 'Invalid selfie image data provided.' }, b, '/resident/register');
                }
                const selfieFileName = `selfie_${crypto.randomBytes(12).toString('hex')}.${decoded.ext}`;
                selfiePath = await putBuffer(`selfies/${selfieFileName}`, decoded.buffer, decoded.contentType);
            }

            const firstName = String(b.first_name).trim().toUpperCase();
            const middleName = b.middle_name && String(b.middle_name).trim() ? String(b.middle_name).trim().toUpperCase() : null;
            const lastName = String(b.last_name).trim().toUpperCase();
            const suffix = b.suffix && String(b.suffix).trim() ? String(b.suffix).trim().toUpperCase() : null;
            const composedName = [firstName, middleName, lastName, suffix].filter(Boolean).join(' ');
            const passwordValue = isGoogleUser ? null : await hashSecret(b.password);

            const rejectedByEmail = await findRejectedByContact('email', actualEmail);
            const rejectedByPhone = await findRejectedByContact('phone_number', actualPhone);
            const rejectedUser = rejectedByEmail || rejectedByPhone;

            let savedUser;
            const fieldsList = {
                name: composedName,
                first_name: firstName,
                middle_name: middleName,
                last_name: lastName,
                suffix,
                email: actualEmail,
                phone_number: actualPhone,
                password: passwordValue,
                google_id: isGoogleUser ? String(googleId) : null,
                birthdate: b.birthdate,
                age: Number(b.age) || null,
                birthplace: String(b.birthplace).trim().toUpperCase(),
                gender: b.gender,
                civil_status: b.civil_status,
                nationality: String(b.nationality).trim().toUpperCase(),
                occupation: String(b.occupation).trim().toUpperCase(),
                purok: String(b.purok).trim().toUpperCase(),
                sitio: b.sitio && String(b.sitio).trim() ? String(b.sitio).trim().toUpperCase() : null,
                barangay_address: String(b.barangay_address).trim().toUpperCase(),
                municipality: String(b.municipality).trim().toUpperCase(),
                zip_code: b.zip_code,
                id_type: b.id_type,
                proof_of_residency: imagePath,
                selfie_photo: selfiePath,
                face_verified_at: selfiePath ? new Date() : null,
                security_pin: null,
                role: 'Resident',
                status: 'pending_approval',
            };

            if (rejectedUser) {
                if (rejectedByEmail && rejectedByPhone && rejectedByPhone.id !== rejectedUser.id) {
                    await query('UPDATE users SET phone_number = NULL WHERE id = $1', [rejectedByPhone.id]);
                }
                if (rejectedUser.proof_of_residency && rejectedUser.proof_of_residency !== imagePath) {
                    await deleteFile(rejectedUser.proof_of_residency, ['residency_proofs', 'valid_ids']);
                }
                if (rejectedUser.selfie_photo && rejectedUser.selfie_photo !== selfiePath) {
                    await deleteFile(rejectedUser.selfie_photo, ['selfies']);
                }

                const cols = Object.keys(fieldsList);
                const sets = cols.map((c, idx) => `"${c}" = $${idx + 1}`).join(', ');
                const vals = Object.values(fieldsList);
                savedUser = await queryOne(
                    `UPDATE users SET ${sets}, email_verified_at = NOW(), updated_at = NOW() WHERE id = $${cols.length + 1} RETURNING *`,
                    [...vals, rejectedUser.id]
                );
            } else {
                const userIdCode = `USR-${String(crypto.randomInt(0, 100000)).padStart(5, '0')}`;
                const allData = { user_id: userIdCode, ...fieldsList };
                const cols = Object.keys(allData);
                const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
                savedUser = await queryOne(
                    `INSERT INTO users (${cols.map((c) => `"${c}"`).join(', ')}, email_verified_at, created_at, updated_at)
                     VALUES (${placeholders}, NOW(), NOW(), NOW()) RETURNING *`,
                    Object.values(allData)
                );
            }

            await NotificationService.notifyAdmins('App\\Notifications\\NewUserRegistrationNotification', {
                type: 'new_registration',
                user_id: savedUser.id,
                name: savedUser.name,
                message: `New resident registration pending approval: ${savedUser.name}.`,
                link: '/admin/account-approvals',
            });

            const notifyMethod = !savedUser.email ? 'phone' : 'email';
            await new Promise((resolve) => req.session.destroy(() => resolve()));
            return res.redirect(`/resident/pending-approval?notify=${notifyMethod}`);
        }
    );

    // Complete registration (for legacy 'incomplete' accounts)
    app.get('/complete-registration', requireAuth('/resident/login'), requireResident, (req, res) => {
        if (req.user.status !== 'incomplete') {
            return res.redirectBackWithErrors({ email: 'Your account is already being processed or is approved.' }, false, '/resident/login');
        }
        return res.render('resident/complete_registration', { user: req.user });
    });

    app.post(
        '/complete-registration',
        requireAuth('/resident/login'),
        requireResident,
        uploadRegistrationFiles.fields([
            { name: 'proof_of_residency', maxCount: 1 },
            { name: 'selfie_photo', maxCount: 1 },
            { name: 'selfie_upload', maxCount: 1 },
        ]),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            const user = req.user;
            if (user.status !== 'incomplete') {
                req.flashErrors({ email: 'Your account is already being processed or is approved.' });
                return res.redirect('/resident/login');
            }

            const b = req.body || {};
            const files = req.files || {};
            const errs = {};
            if (!b.terms) errs.terms = ['You must agree to the terms.'];
            if (!b.id_type) errs.id_type = ['ID type is required.'];
            if (!files.proof_of_residency?.[0]) errs.proof_of_residency = ['Proof of residency is required.'];
            if (user.google_id) {
                if (!b.password || String(b.password).length < 8) errs.password = ['Password must be at least 8 characters.'];
                if (!b.birthdate) errs.birthdate = ['Birthdate is required.'];
                if (!b.gender) errs.gender = ['Gender is required.'];
            }

            if (Object.keys(errs).length > 0) {
                return res.redirectBackWithErrors(errs, b, '/complete-registration');
            }

            const imagePath = await uploadBuffer(
                files.proof_of_residency[0].buffer,
                'residency_proofs',
                files.proof_of_residency[0].originalname,
                files.proof_of_residency[0].mimetype
            );

            let selfiePath = user.selfie_photo;
            let faceVerifiedAt = user.face_verified_at;
            if (files.selfie_upload?.[0] || files.selfie_photo?.[0]) {
                const sf = files.selfie_upload?.[0] || files.selfie_photo?.[0];
                selfiePath = await uploadBuffer(sf.buffer, 'selfies', sf.originalname, sf.mimetype);
                faceVerifiedAt = new Date();
            } else if (b.selfie_photo && typeof b.selfie_photo === 'string' && b.selfie_photo.trim() !== '') {
                const decoded = decodeBase64Image(b.selfie_photo);
                if (!decoded) {
                    return res.redirectBackWithErrors({ selfie_photo: 'Invalid selfie image data provided.' }, b, '/complete-registration');
                }
                const selfieFileName = `selfie_${crypto.randomBytes(12).toString('hex')}.${decoded.ext}`;
                selfiePath = await putBuffer(`selfies/${selfieFileName}`, decoded.buffer, decoded.contentType);
                faceVerifiedAt = new Date();
            }

            const extraPassword = user.google_id ? await hashSecret(b.password) : user.password;
            const extraBirthdate = user.google_id ? b.birthdate : user.birthdate;
            const extraGender = user.google_id ? b.gender : user.gender;

            await query(
                `UPDATE users
                 SET id_type = $1, proof_of_residency = $2, status = 'pending_approval',
                     selfie_photo = $3, face_verified_at = $4, password = $5,
                     birthdate = $6, gender = $7, updated_at = NOW()
                 WHERE id = $8`,
                [b.id_type, imagePath, selfiePath, faceVerifiedAt, extraPassword, extraBirthdate, extraGender, user.id]
            );

            await NotificationService.notifyAdmins('App\\Notifications\\NewUserRegistrationNotification', {
                type: 'new_registration',
                user_id: user.id,
                name: user.name,
                message: `New resident registration pending approval: ${user.name}.`,
                link: '/admin/account-approvals',
            });

            const notifyMethod = !user.email ? 'phone' : 'email';
            await new Promise((resolve) => req.session.destroy(() => resolve()));
            return res.redirect(`/resident/pending-approval?notify=${notifyMethod}`);
        }
    );

    // Pending approval screen
    app.get('/resident/pending-approval', (req, res) => {
        if (req.user && String(req.user.role || '').trim().toLowerCase() === 'admin') {
            return res.redirect('/admin');
        }
        req.routeName = 'resident.pending';
        return res.render('resident/pending_approval');
    });

    // Setup 6-digit security PIN
    app.post('/resident/setup-pin', requireAuth('/resident/login'), requireResident, requireVerified, async (req, res) => {
        if (req.user.security_pin) {
            return res.redirectBackWithErrors({ security_pin: 'A security PIN is already configured on your account.' }, false, '/resident');
        }
        const pin = String(req.body?.security_pin || '');
        const pinConf = String(req.body?.security_pin_confirmation || '');
        if (!/^\d{6}$/.test(pin) || pin !== pinConf) {
            return res.redirectBackWithErrors({ security_pin: 'Security PIN must be 6 digits and match confirmation.' }, false, '/resident');
        }

        const hashed = await hashSecret(pin);
        await query('UPDATE users SET security_pin = $1, updated_at = NOW() WHERE id = $2', [hashed, req.user.id]);
        return res.redirectWithFlash('/resident', 'success', 'Security PIN successfully established! You can now use it for quick logins.');
    });

    // Logout
    app.post('/resident/logout', (req, res) => {
        req.session.destroy(() => {
            res.clearCookie('ebarangay_session');
            res.redirect('/resident/login');
        });
    });
}
