import { env } from '../config/env.js';
import { formatPhoneForSms } from '../lib/validators.js';

export async function sendSms(rawPhone, message, timeoutMs = 10000) {
    const formatted = formatPhoneForSms(rawPhone);
    if (!formatted || !env.textbeeApiKey || !env.textbeeDeviceId) {
        return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
            method: 'POST',
            headers: {
                'x-api-key': env.textbeeApiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                deviceId: env.textbeeDeviceId,
                recipients: [formatted],
                message,
            }),
            signal: controller.signal,
        });
        if (!resp.ok) {
            const txt = await resp.text();
            console.error('[Textbee SMS Error]', resp.status, txt);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[Textbee SMS Network Error]', err.message);
        return false;
    } finally {
        clearTimeout(timer);
    }
}
