import { env } from '../config/env.js';

export async function verifyRecaptchaToken(token) {
    if (!env.recaptchaSecretKey) return true;
    if (!token || typeof token !== 'string' || token.trim() === '') return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const params = new URLSearchParams();
        params.append('secret', env.recaptchaSecretKey);
        params.append('response', token.trim());

        const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
            signal: controller.signal,
        });

        const data = await resp.json().catch(() => null);
        if (data && data.success === true) return true;
        console.warn('[reCAPTCHA rejected]', data?.['error-codes'] || []);
        return false;
    } catch (err) {
        console.warn('[reCAPTCHA verification error]', err.message);
        return false;
    } finally {
        clearTimeout(timer);
    }
}
