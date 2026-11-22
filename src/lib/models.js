import crypto from 'crypto';
import { query, queryOne } from '../db/pool.js';

export const CONCERN_CATEGORIES = [
    'Infrastructure',
    'Road Damage',
    'Street Lighting',
    'Drainage',
    'Garbage Collection',
    'Public Cleanliness',
    'Water Supply',
    'Illegal Dumping',
    'Noise Complaint',
    'Stray Animals',
    'Public Safety',
    'Others',
];

export const CONCERN_STATUSES = [
    'Pending',
    'Under Review',
    'In Progress',
    'Resolved',
    'Rejected',
];

export const RESIDENT_CONCERN_CATEGORIES = [
    'Infrastructure & Roads',
    'Sanitation & Garbage',
    'Safety & Security',
    'Noise & Disturbances',
    'Others',
];

export function hydrateUser(row) {
    if (!row) return null;
    const roleLower = String(row.role || '').trim().toLowerCase();
    const safePicBase = row.profile_picture ? String(row.profile_picture).replace(/\\/g, '/').split('/').pop() : null;
    let profilePictureUrl = null;
    if (row.profile_picture) {
        if (/^https?:\/\//i.test(row.profile_picture) || row.profile_picture.startsWith('data:image/')) {
            profilePictureUrl = row.profile_picture;
        } else if (roleLower === 'admin') {
            profilePictureUrl = `/admin/profile/avatar/${encodeURIComponent(safePicBase)}`;
        } else {
            profilePictureUrl = `/media/profile-avatar/${encodeURIComponent(safePicBase)}`;
        }
    }

    const idFrontPath = row.proof_of_residency || row.id_photo || null;
    let idDocumentUrl = null;
    if (idFrontPath) {
        if (/^https?:\/\//i.test(idFrontPath) || idFrontPath.startsWith('data:image/')) {
            idDocumentUrl = idFrontPath;
        } else {
            const base = String(idFrontPath).replace(/\\/g, '/').split('/').pop();
            idDocumentUrl = `/admin/resident-id-document/${encodeURIComponent(row.id)}/${encodeURIComponent(base)}`;
        }
    }

    let selfiePhotoUrl = null;
    if (row.selfie_photo) {
        if (/^https?:\/\//i.test(row.selfie_photo) || row.selfie_photo.startsWith('data:image/')) {
            selfiePhotoUrl = row.selfie_photo;
        } else {
            const base = String(row.selfie_photo).replace(/\\/g, '/').split('/').pop();
            selfiePhotoUrl = `/admin/resident-selfie/${encodeURIComponent(base)}`;
        }
    }

    const formattedAddress = [
        row.house_number,
        row.street,
        row.barangay_address,
        row.municipality,
        row.province,
        row.zip_code,
    ]
        .filter((v) => v && String(v).trim() !== '')
        .join(', ');

    return {
        ...row,
        id: Number(row.id),
        profile_picture_url: profilePictureUrl,
        id_front_path: idFrontPath,
        id_document_url: idDocumentUrl,
        selfie_photo_url: selfiePhotoUrl,
        formatted_address: formattedAddress,
        has_verified_email: Boolean(row.email_verified_at),
    };
}

export function hydrateDocumentType(row) {
    if (!row) return null;
    const nameLower = String(row.name || '').toLowerCase();
    let icon = 'fa-file-lines';
    if (nameLower.includes('business') || nameLower.includes('permit')) icon = 'fa-store';
    else if (nameLower.includes('residency') || nameLower.includes('resident')) icon = 'fa-house-chimney-user';
    else if (nameLower.includes('medical') || nameLower.includes('health') || nameLower.includes('hospital')) icon = 'fa-kit-medical';
    else if (nameLower.includes('indigency') || nameLower.includes('indigent')) icon = 'fa-hand-holding-heart';
    else if (nameLower.includes('cohabitation')) icon = 'fa-people-roof';
    else if (nameLower.includes('bail') || nameLower.includes('court') || nameLower.includes('legal') || nameLower.includes('law')) icon = 'fa-gavel';
    else if (nameLower.includes('electric') || nameLower.includes('power') || nameLower.includes('meralco')) icon = 'fa-bolt';
    else if (nameLower.includes('burial') || nameLower.includes('death') || nameLower.includes('mortuary') || nameLower.includes('funeral')) icon = 'fa-cross';
    else if (nameLower.includes('senior') && (nameLower.includes('cash') || nameLower.includes('pension') || nameLower.includes('money') || nameLower.includes('assistance') || nameLower.includes('subsidy'))) icon = 'fa-hand-holding-dollar';
    else if (nameLower.includes('senior')) icon = 'fa-user-tie';
    else if (nameLower.includes('job') || nameLower.includes('employment') || nameLower.includes('seeker')) icon = 'fa-briefcase';
    else if (nameLower.includes('oath') || nameLower.includes('undertaking') || nameLower.includes('affidavit')) icon = 'fa-file-signature';
    else if (nameLower.includes('clearance')) icon = 'fa-file-shield';
    else if (nameLower.includes('scholarship') || nameLower.includes('school') || nameLower.includes('student')) icon = 'fa-graduation-cap';
    else if (nameLower.includes('probation') || nameLower.includes('parole')) icon = 'fa-clipboard-check';
    else if (nameLower.includes('receipt') || nameLower.includes('acknowledgement')) icon = 'fa-receipt';
    else if (nameLower.includes('id') || nameLower.includes('identification') || nameLower.includes('card')) icon = 'fa-id-card';

    let reqList = [];
    if (Array.isArray(row.requirements)) {
        reqList = row.requirements;
    } else if (typeof row.requirements === 'string' && row.requirements.trim()) {
        try {
            const parsed = JSON.parse(row.requirements);
            reqList = Array.isArray(parsed) ? parsed : row.requirements.split(',').map((s) => s.trim()).filter(Boolean);
        } catch (_) {
            reqList = row.requirements.split(',').map((s) => s.trim()).filter(Boolean);
        }
    }

    const numericFee = row.fee === null || row.fee === undefined ? 0 : Number(row.fee);
    const formattedFee = !numericFee || numericFee === 0
        ? 'FREE'
        : `₱${numericFee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    return {
        ...row,
        id: Number(row.id),
        fee: numericFee,
        is_active: Boolean(row.is_active),
        requirements: reqList,
        requirements_list: reqList,
        icon,
        formatted_fee: formattedFee,
    };
}

export function hydrateDocumentRequest(row, userObj = null) {
    if (!row) return null;
    let docs = row.documents;
    if (typeof docs === 'string') {
        try { docs = JSON.parse(docs); } catch (_) { docs = null; }
    }
    let documentsList = [];
    if (Array.isArray(docs) && docs.length > 0) {
        documentsList = docs.map((doc) => ({
            type: typeof doc === 'object' && doc !== null ? (doc.type || '') : String(doc || ''),
            purpose: typeof doc === 'object' && doc !== null ? (doc.purpose ?? row.purpose ?? '') : (row.purpose ?? ''),
            fee: typeof doc === 'object' && doc !== null ? (doc.fee ?? null) : null,
            is_generated: typeof doc === 'object' && doc !== null ? Boolean(doc.is_generated) : false,
        }));
    } else if (row.document_type) {
        documentsList = [{
            type: row.document_type,
            purpose: row.purpose || '',
            fee: row.fee,
            is_generated: Boolean(row.is_generated),
        }];
    }

    let rawAtt = row.attachments;
    if (typeof rawAtt === 'string') {
        try { rawAtt = JSON.parse(rawAtt); } catch (_) { rawAtt = []; }
    }
    const attachmentsList = [];
    if (Array.isArray(rawAtt)) {
        for (const item of rawAtt) {
            if (item && typeof item === 'object' && item.file_path) {
                const ext = String(item.file_path).split('.').pop().toLowerCase();
                const isImg = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
                attachmentsList.push({
                    file_path: item.file_path,
                    file_name: item.file_name || String(item.file_path).replace(/\\/g, '/').split('/').pop(),
                    doc_type: item.doc_type || 'Supporting Document',
                    file_type: item.file_type || (isImg ? 'image' : 'document'),
                    file_size: item.file_size || null,
                    source: 'request',
                });
            }
        }
    }

    const mi = row.middle_initial ? `${row.middle_initial}. ` : '';
    const residentName = `${row.first_name || ''} ${mi}${row.last_name || ''}`.trim() || row.resident_name || '';

    let resolvedIdType = row.id_type || (userObj && userObj.id_type) || null;
    if (!resolvedIdType && attachmentsList.length > 0) {
        for (const att of attachmentsList) {
            if (att.doc_type && /id|license|passport/i.test(att.doc_type)) {
                resolvedIdType = att.doc_type;
                break;
            }
        }
    }

    return {
        ...row,
        id: Number(row.id),
        user_id: row.user_id !== null && row.user_id !== undefined ? Number(row.user_id) : null,
        document_type_id: row.document_type_id !== null && row.document_type_id !== undefined ? Number(row.document_type_id) : null,
        fee: row.fee !== null && row.fee !== undefined ? Number(row.fee) : null,
        is_generated: Boolean(row.is_generated),
        documents: Array.isArray(docs) ? docs : documentsList,
        documents_list: documentsList,
        document_types_list: documentsList.map((d) => d.type).filter(Boolean),
        attachments: Array.isArray(rawAtt) ? rawAtt : [],
        attachments_list: attachmentsList,
        resident_name: residentName,
        resolved_id_type: resolvedIdType,
        user: userObj,
        hasMultipleDocuments() {
            return documentsList.length > 1;
        },
    };
}

export const BarangaySetting = {
    async get(key, defaultVal = null) {
        const row = await queryOne('SELECT value FROM barangay_settings WHERE key = $1 LIMIT 1', [key]);
        if (row && row.value !== null && row.value !== '') return row.value;
        return defaultVal;
    },
    async getRecord(key) {
        return queryOne('SELECT * FROM barangay_settings WHERE key = $1 LIMIT 1', [key]);
    },
    async set(key, value, group = 'general') {
        const val = value === undefined ? null : value === null ? null : String(value);
        await query(
            `INSERT INTO barangay_settings (key, value, "group", created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "group" = EXCLUDED."group", updated_at = NOW()`,
            [key, val, group]
        );
    },
    async allAssoc() {
        const { rows } = await query('SELECT key, value FROM barangay_settings');
        const map = {};
        for (const r of rows) map[r.key] = r.value;
        return map;
    },
};

export const ActivityLog = {
    async record(action, description, userId = null, req = null) {
        let resolvedUserId = userId;
        if (!resolvedUserId && req?.user?.id) {
            resolvedUserId = req.user.id;
        }
        if (!resolvedUserId) {
            const admin = await queryOne("SELECT id FROM users WHERE LOWER(role) = 'admin' ORDER BY id ASC LIMIT 1");
            resolvedUserId = admin?.id || null;
        }
        if (!resolvedUserId) return;

        try {
            const ip = req ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null) : null;
            const ua = req ? (req.get('user-agent') || null) : null;
            await query(
                `INSERT INTO activity_logs (user_id, action, description, ip_address, user_agent, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
                [resolvedUserId, String(action).slice(0, 100), description || null, ip ? String(ip).slice(0, 45) : null, ua]
            );
        } catch (err) {
            console.warn('ActivityLog recording skipped:', err.message);
        }
    },
};

export const NotificationService = {
    async notifyUser(userId, type, data) {
        if (!userId) return;
        const id = crypto.randomUUID();
        await query(
            `INSERT INTO notifications (id, type, notifiable_type, notifiable_id, data, created_at, updated_at)
             VALUES ($1, $2, 'App\\Models\\User', $3, $4::jsonb, NOW(), NOW())`,
            [id, type, userId, JSON.stringify(data)]
        );
    },
    async notifyAdmins(type, data) {
        const { rows: admins } = await query("SELECT id FROM users WHERE LOWER(role) = 'admin'");
        for (const admin of admins) {
            try {
                await this.notifyUser(admin.id, type, data);
            } catch (_) {}
        }
    },
    async getUserNotifications(userId, limit = 15) {
        const countRes = await queryOne(
            'SELECT COUNT(*)::int AS cnt FROM notifications WHERE notifiable_id = $1 AND read_at IS NULL',
            [userId]
        );
        const { rows } = await query(
            'SELECT id, type, data, read_at, created_at FROM notifications WHERE notifiable_id = $1 ORDER BY created_at DESC LIMIT $2',
            [userId, limit]
        );
        const list = rows.map((r) => ({
            ...r,
            data: typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {}),
        }));
        return {
            unreadCount: countRes?.cnt || 0,
            notifications: list,
        };
    },
    async markAllRead(userId) {
        await query('UPDATE notifications SET read_at = NOW(), updated_at = NOW() WHERE notifiable_id = $1 AND read_at IS NULL', [userId]);
    },
    async markOneRead(userId, notificationId) {
        await query('UPDATE notifications SET read_at = NOW(), updated_at = NOW() WHERE id = $1 AND notifiable_id = $2', [notificationId, userId]);
    },
};
