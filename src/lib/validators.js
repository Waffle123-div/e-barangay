export function cleanPhone(raw) {
    if (!raw) return null;
    const cleaned = String(raw).replace(/[^0-9]/g, '');
    return cleaned || null;
}

export function formatPhoneForSms(raw) {
    const clean = cleanPhone(raw);
    if (!clean) return null;
    if (clean.startsWith('09')) return `+63${clean.slice(1)}`;
    if (clean.startsWith('639')) return `+${clean}`;
    if (clean.startsWith('9') && clean.length === 10) return `+63${clean}`;
    return String(raw).trim();
}

export function isValidEmail(val) {
    if (!val || typeof val !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
}

export function isValidImageSignature(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
    // JPEG
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
    // PNG
    if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return true;
    }
    // WEBP
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return true;
    }
    // GIF
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
        return true;
    }
    return false;
}

export function decodeBase64Image(dataUri, maxBytes = 5 * 1024 * 1024) {
    if (typeof dataUri !== 'string') return null;
    const match = dataUri.trim().match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/s);
    if (!match) return null;
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer || buffer.length === 0 || buffer.length > maxBytes || !isValidImageSignature(buffer)) {
        return null;
    }
    const ext = match[1] === 'png' ? 'png' : match[1] === 'webp' ? 'webp' : 'jpg';
    const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return { buffer, ext, contentType };
}

export function isSafeActionUrl(val) {
    const trimmed = String(val || '').trim();
    if (!trimmed) return true;
    return /^(https?:\/\/|\/(?!\/))/i.test(trimmed);
}

export function sanitizeIntendedUrl(intended) {
    if (typeof intended !== 'string' || !intended) return null;
    if (!intended.startsWith('/resident/request-document') && intended !== '/home') return null;
    if (intended.includes('://') || intended.includes('..')) return null;
    return intended;
}

export function maskPhoneDisplay(phone) {
    if (!phone) return '';
    return String(phone).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}

export function parseCsvOrLines(text) {
    if (!text) return [];
    return String(text)
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}
