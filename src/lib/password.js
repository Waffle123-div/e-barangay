import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

/**
 * Hash a plaintext password or PIN using bcryptjs ($2b$ / $2a$).
 */
export async function hashSecret(plain) {
    return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password/PIN against a bcrypt hash,
 * transparently supporting Laravel's $2y$ prefix.
 */
export async function verifySecret(plain, storedHash) {
    if (!plain || !storedHash) return false;
    const normalizedHash = String(storedHash).replace(/^\$2y\$/, '$2a$');
    try {
        return await bcrypt.compare(String(plain), normalizedHash);
    } catch (_) {
        return false;
    }
}
