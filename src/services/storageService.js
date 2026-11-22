import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { env, ROOT_DIR } from '../config/env.js';

let supabaseAdmin = null;

function getSupabaseAdmin() {
    if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;
    if (!supabaseAdmin) {
        supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
    }
    return supabaseAdmin;
}

export function usesSupabaseStorage() {
    return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey && env.supabaseStorageBucket);
}

const MIME_MAP = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.zip': 'application/zip',
};

export function guessMimeType(filePath, fallback = 'application/octet-stream') {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    return MIME_MAP[ext] || fallback;
}

function normalizeCandidatePaths(rawPath, directoryHints = []) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return [];
    const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.includes('..')) return [];

    const stripped = normalized.replace(/^(?:storage|public)\//, '');
    const safeBase = path.posix.basename(stripped);
    const candidates = [normalized, stripped];
    for (const hint of directoryHints) {
        const cleanHint = String(hint || '').replace(/^\/+|\/+$/g, '');
        if (cleanHint && safeBase) {
            candidates.push(`${cleanHint}/${safeBase}`);
        }
    }
    if (safeBase) candidates.push(safeBase);
    return [...new Set(candidates.filter(Boolean))];
}

export async function uploadBuffer(buffer, directory, originalName = 'file.bin', contentType = null) {
    const cleanDir = String(directory || '').replace(/^\/+|\/+$/g, '');
    const ext = path.extname(originalName || '').toLowerCase() || '.bin';
    const randomName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    const objectPath = cleanDir ? `${cleanDir}/${randomName}` : randomName;
    const mime = contentType || guessMimeType(originalName);

    await putBuffer(objectPath, buffer, mime);
    return objectPath;
}

export async function putBuffer(relativePath, buffer, contentType = null) {
    const cleanPath = String(relativePath || '').replace(/^\/+/, '');
    const mime = contentType || guessMimeType(cleanPath);
    const sb = getSupabaseAdmin();

    if (sb) {
        const { error } = await sb.storage
            .from(env.supabaseStorageBucket)
            .upload(cleanPath, buffer, { contentType: mime, upsert: true });
        if (error) {
            throw new Error(`Supabase Storage upload failed: ${error.message}`);
        }
        return cleanPath;
    }

    if (env.isVercel) {
        throw new Error('Supabase Storage is required on Vercel (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).');
    }

    const localTarget = path.join(ROOT_DIR, 'storage', 'uploads', cleanPath);
    await fs.mkdir(path.dirname(localTarget), { recursive: true });
    await fs.writeFile(localTarget, buffer);
    return cleanPath;
}

export async function deleteFile(rawPath, directoryHints = []) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return;
    const candidates = normalizeCandidatePaths(trimmed, directoryHints);
    if (candidates.length === 0) return;

    const sb = getSupabaseAdmin();
    if (sb) {
        try {
            await sb.storage.from(env.supabaseStorageBucket).remove(candidates);
        } catch (err) {
            console.warn('[storageService.deleteFile]', err.message);
        }
    }

    if (!env.isVercel) {
        for (const c of candidates) {
            const p = path.join(ROOT_DIR, 'storage', 'uploads', c);
            try {
                await fs.unlink(p);
            } catch (_) {}
        }
    }
}

export async function readFileBuffer(rawPath, directoryHints = []) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) {
        return { redirectUrl: trimmed };
    }

    const candidates = normalizeCandidatePaths(trimmed, directoryHints);
    if (candidates.length === 0) return null;

    // 1. Check Supabase Storage first
    const sb = getSupabaseAdmin();
    if (sb) {
        for (const candidate of candidates) {
            try {
                const { data, error } = await sb.storage
                    .from(env.supabaseStorageBucket)
                    .download(candidate);
                if (!error && data) {
                    const arrBuf = await data.arrayBuffer();
                    return {
                        buffer: Buffer.from(arrBuf),
                        filename: path.posix.basename(candidate),
                        mimeType: guessMimeType(candidate),
                    };
                }
            } catch (_) {}
        }
    }

    // 2. Check bundled templates, local uploads, and public directories
    const localRoots = [
        path.join(ROOT_DIR, 'templates'),
        path.join(ROOT_DIR, 'templates', 'document_templates'),
        path.join(ROOT_DIR, 'storage', 'uploads'),
        path.join(ROOT_DIR, 'public'),
    ];

    for (const rootDir of localRoots) {
        for (const candidate of candidates) {
            const resolved = path.resolve(rootDir, candidate);
            if (!resolved.startsWith(path.resolve(rootDir))) continue;
            try {
                const stat = await fs.stat(resolved);
                if (stat.isFile()) {
                    const buffer = await fs.readFile(resolved);
                    return {
                        buffer,
                        filename: path.basename(resolved),
                        mimeType: guessMimeType(resolved),
                    };
                }
            } catch (_) {}
        }
    }

    return null;
}

export async function serveFile(res, rawPath, options = {}) {
    const {
        directoryHints = [],
        notFoundMessage = 'File not found.',
        download = false,
        downloadFilename = null,
    } = options;

    const found = await readFileBuffer(rawPath, directoryHints);
    if (!found) {
        return res.status(404).send(notFoundMessage);
    }

    if (found.redirectUrl) {
        return res.redirect(found.redirectUrl);
    }

    const safeName = path.basename(String(downloadFilename || found.filename || 'file').replace(/\\/g, '/'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', found.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeName.replace(/"/g, '')}"`);
    return res.send(found.buffer);
}

export async function listAvailableTemplates() {
    const results = new Set();

    const docTemplatesDir = path.join(ROOT_DIR, 'templates', 'document_templates');
    try {
        const files = await fs.readdir(docTemplatesDir);
        for (const f of files) {
            if (f.toLowerCase().endsWith('.docx') && !f.toLowerCase().startsWith('test_')) {
                results.add(f);
            }
        }
    } catch (_) {}

    const rootTemplatesDir = path.join(ROOT_DIR, 'templates');
    try {
        const files = await fs.readdir(rootTemplatesDir);
        for (const f of files) {
            if (f.toLowerCase().endsWith('_template.docx')) {
                results.add(f);
            }
        }
    } catch (_) {}

    const sb = getSupabaseAdmin();
    if (sb) {
        try {
            const { data } = await sb.storage.from(env.supabaseStorageBucket).list('document_templates', { limit: 200 });
            if (Array.isArray(data)) {
                for (const item of data) {
                    if (item.name && item.name.toLowerCase().endsWith('.docx')) {
                        results.add(item.name);
                    }
                }
            }
        } catch (_) {}
    }

    return [...results].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

export function settingImageUrl(key, rawPath) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:image/')) {
        return trimmed;
    }
    const base = path.posix.basename(trimmed.replace(/\\/g, '/'));
    if (!base) return null;
    return `/branding/${encodeURIComponent(key)}/${encodeURIComponent(base)}`;
}
