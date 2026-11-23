import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '../..');

function cleanUrl(val, fallback) {
    const raw = (val || fallback || '').trim();
    return raw.replace(/\/+$/, '');
}

const isVercel = Boolean(process.env.VERCEL);
const port = Number(process.env.PORT || 3000);
const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';

export const env = {
    nodeEnv: process.env.NODE_ENV || (isVercel ? 'production' : 'development'),
    isProduction: (process.env.NODE_ENV || (isVercel ? 'production' : 'development')) === 'production',
    isVercel,
    port,
    appName: process.env.APP_NAME || 'E-Barangay',
    appUrl: cleanUrl(process.env.APP_URL || vercelUrl, `http://localhost:${port}`),
    sessionSecret: (process.env.SESSION_SECRET || process.env.APP_KEY || 'dev-ebarangay-insecure-change-me-in-production').trim(),
    sessionLifetimeMinutes: Math.max(5, Number(process.env.SESSION_LIFETIME || 120)),
    databaseUrl: (process.env.DATABASE_URL || '').trim(),
    supabaseUrl: cleanUrl(process.env.SUPABASE_URL, ''),
    supabaseAnonKey: (process.env.SUPABASE_ANON_KEY || '').trim(),
    supabaseServiceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    supabaseStorageBucket: (process.env.SUPABASE_STORAGE_BUCKET || 'ebarangay-files').trim(),
    googleClientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    googleRedirectUrl: (process.env.GOOGLE_REDIRECT_URL || '').trim(),
    mailMailer: (process.env.MAIL_MAILER || '').trim().toLowerCase(),
    mailFromAddress: (process.env.MAIL_FROM_ADDRESS || 'cogoneast.system@gmail.com').trim(),
    mailFromName: (process.env.MAIL_FROM_NAME || 'E-Barangay Cogon East').trim(),
    resendApiKey: (process.env.RESEND_API_KEY || process.env.RESEND_KEY || '').trim(),
    resendFromAddress: (process.env.RESEND_FROM_ADDRESS || 'onboarding@resend.dev').trim(),
    mailjetApiKey: (process.env.MAILJET_API_KEY || process.env.MAIL_USERNAME || '').trim(),
    mailjetSecretKey: (process.env.MAILJET_SECRET_KEY || process.env.MAIL_PASSWORD || '').trim(),
    mailHost: (process.env.MAIL_HOST || '').trim(),
    mailPort: Number(process.env.MAIL_PORT || 587),
    mailUsername: (process.env.MAIL_USERNAME || '').trim(),
    mailPassword: (process.env.MAIL_PASSWORD || '').trim(),
    textbeeApiKey: (process.env.TEXTBEE_API_KEY || '').trim(),
    textbeeDeviceId: (process.env.TEXTBEE_DEVICE_ID || '').trim(),
    recaptchaSiteKey: (process.env.RECAPTCHA_SITE_KEY || '').trim(),
    recaptchaSecretKey: (process.env.RECAPTCHA_SECRET_KEY || '').trim(),
    geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
    geminiModel: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    groqApiKey: (process.env.GROQ_API_KEY || '').trim(),
};

export function resolveGoogleRedirectUrl(req) {
    if (env.googleRedirectUrl) return env.googleRedirectUrl;
    const base = getRequestBaseUrl(req);
    return `${base}/auth/google/callback`;
}

export function getRequestBaseUrl(req) {
    if (req) {
        const protoHeader = req.headers['x-forwarded-proto'];
        const proto = (typeof protoHeader === 'string' && protoHeader.split(',')[0].trim()) || req.protocol || 'http';
        const hostHeader = req.headers['x-forwarded-host'] || req.get('host');
        if (hostHeader) {
            return `${proto}://${hostHeader}`.replace(/\/+$/, '');
        }
    }
    return env.appUrl;
}
