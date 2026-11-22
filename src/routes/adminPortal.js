import crypto from 'crypto';
import path from 'path';
import { query, queryOne, withTransaction } from '../db/pool.js';
import {
    ActivityLog,
    BarangaySetting,
    CONCERN_STATUSES,
    hydrateDocumentRequest,
    hydrateDocumentType,
    hydrateUser,
    NotificationService,
} from '../lib/models.js';
import { hashSecret, verifySecret } from '../lib/password.js';
import { formatPhoneForSms, isSafeActionUrl, parseCsvOrLines } from '../lib/validators.js';
import { diffForHumans } from '../lib/viewHelpers.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { verifyMultipartCsrfAndMethod } from '../middleware/csrf.js';
import { populateAdminLayoutLocals } from '../middleware/layoutLocals.js';
import {
    uploadAnySettings,
    uploadDocx10MB,
    uploadImage2MB,
    uploadImage5MB,
    uploadImageOrPdf10MB,
} from '../middleware/upload.js';
import { generatePostgresBackupSql } from '../services/backupService.js';
import {
    sendAccountApprovedEmail,
    sendAccountRejectedEmail,
    sendDocumentAcceptedEmail,
    sendDocumentReadyEmail,
    sendDocumentRejectedEmail,
} from '../services/mailService.js';
import { broadcastRealtimeEvent } from '../services/realtimeService.js';
import { sendSms } from '../services/smsService.js';
import {
    deleteFile,
    listAvailableTemplates,
    putBuffer,
    readFileBuffer,
    serveFile,
    uploadBuffer,
} from '../services/storageService.js';
import { bundleMultipleDocumentsZip, generateWordDocumentBuffer } from '../services/wordService.js';

function adminGuard(routeName) {
    return [
        (req, res, next) => {
            req.routeName = routeName;
            res.locals.currentRoute = routeName;
            next();
        },
        requireAuth('/admin/login'),
        requireAdmin,
        populateAdminLayoutLocals,
    ];
}

function renderAdmin(res, view, locals = {}) {
    return res.render(view, locals, (err, html) => {
        if (err) throw err;
        return res.render('admin/layouts/admin', { ...locals, body: html });
    });
}

function resolveExistingTemplateSelection(selectedTemplate) {
    const safeBase = path.posix.basename(String(selectedTemplate || '').trim());
    return `document_templates/${safeBase}`;
}

async function resolveResidentUser(docRequest) {
    if (docRequest.user_id) {
        const u = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [docRequest.user_id]);
        if (u) return hydrateUser(u);
    }
    if (docRequest.resident_email) {
        const u = await queryOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [docRequest.resident_email]);
        if (u) return hydrateUser(u);
    }
    return null;
}

function buildConcernNotificationMessage(concern, previousStatus, remarks) {
    if (remarks) return `Barangay Staff replied to your concern: "${remarks}"`;
    if (concern.status === 'Under Review' && previousStatus !== 'Under Review') return 'Your concern is now Under Review.';
    if (concern.status === 'In Progress') return 'Your concern is now In Progress.';
    if (concern.status === 'Resolved') return 'Your concern has been marked as Resolved.';
    if (concern.status === 'Rejected') return 'Your concern has been marked as Rejected.';
    return `Your community concern status has been updated to ${concern.status}.`;
}

async function generateUniqueTrackingNumber() {
    const year = new Date().getFullYear();
    for (let i = 0; i < 15; i++) {
        const rand = String(crypto.randomInt(1, 100000)).padStart(5, '0');
        const trk = `REQ-${year}-${rand}`;
        const exists = await queryOne('SELECT id FROM document_requests WHERE tracking_number = $1 LIMIT 1', [trk]);
        if (!exists) return trk;
    }
    return `REQ-${year}-${Date.now().toString().slice(-5)}`;
}

export function registerAdminPortalRoutes(app) {
    // 1. Dashboard
    app.get('/admin', ...adminGuard('admin.dashboard'), async (req, res) => {
        const [totalRow, pendingRow, approvedRow, activeUsersRow, recentRes] = await Promise.all([
            queryOne('SELECT COUNT(*)::int AS cnt FROM document_requests'),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Pending'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Approved'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE LOWER(status) = 'active'"),
            query('SELECT * FROM document_requests ORDER BY created_at DESC LIMIT 5'),
        ]);

        return renderAdmin(res, 'admin/dashboard', {
            totalRequests: totalRow?.cnt || 0,
            pendingReviews: pendingRow?.cnt || 0,
            approvedToday: approvedRow?.cnt || 0,
            activeUsers: activeUsersRow?.cnt || 0,
            recentRequests: recentRes.rows.map((r) => hydrateDocumentRequest(r)),
        });
    });

    // 2. Media Streaming Routes for Admin Staff
    app.get('/admin/profile/avatar/:filename?', ...adminGuard('admin.profile.avatar'), async (req, res) => {
        return serveFile(res, req.user?.profile_picture, {
            directoryHints: ['profile_pictures'],
            notFoundMessage: 'Profile picture not found.',
        });
    });

    app.get('/admin/resident-selfie/:filename', ...adminGuard('admin.resident.selfie'), async (req, res) => {
        const base = path.posix.basename(String(req.params.filename || ''));
        return serveFile(res, `selfies/${base}`, {
            directoryHints: ['selfies'],
            notFoundMessage: 'Selfie not found.',
        });
    });

    app.get('/admin/resident-id-document/:user/:filename?', ...adminGuard('admin.resident.id_document'), async (req, res) => {
        const row = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [req.params.user]);
        if (!row) return res.status(404).send('ID document not found.');
        const target = hydrateUser(row);
        return serveFile(res, target.id_front_path, {
            directoryHints: ['residency_proofs', 'valid_ids'],
            notFoundMessage: 'ID document not found.',
        });
    });

    app.get('/admin/requests/:documentRequest/attachment/:index/:filename?', ...adminGuard('admin.requests.attachment'), async (req, res) => {
        const idx = Number(req.params.index);
        if (!Number.isInteger(idx) || idx < 0) return res.status(404).send('Attachment not found.');
        const row = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.documentRequest]);
        if (!row) return res.status(404).send('Attachment not found.');
        const hydrated = hydrateDocumentRequest(row);
        const att = hydrated.attachments_list[idx];
        if (!att?.file_path) return res.status(404).send('Attachment not found.');

        return serveFile(res, att.file_path, {
            directoryHints: ['attachments', 'residency_proofs', 'valid_ids'],
            notFoundMessage: 'Attachment not found.',
            download: req.query.download === '1' || req.query.download === 'true',
            downloadFilename: att.file_name || null,
        });
    });

    app.get('/admin/concerns/:concern/photo/:filename?', ...adminGuard('admin.concerns.photo'), async (req, res) => {
        const row = await queryOne('SELECT * FROM community_concerns WHERE id = $1 LIMIT 1', [req.params.concern]);
        if (!row) return res.status(404).send('Concern photo not found.');
        return serveFile(res, row.photo_path, {
            directoryHints: ['concerns'],
            notFoundMessage: 'Concern photo not found.',
        });
    });

    app.get('/admin/concerns/:concern/remarks/:remark/attachment', ...adminGuard('admin.concerns.remarks.attachment'), async (req, res) => {
        const concern = await queryOne('SELECT * FROM community_concerns WHERE id = $1 LIMIT 1', [req.params.concern]);
        const remark = await queryOne('SELECT * FROM community_concern_remarks WHERE id = $1 LIMIT 1', [req.params.remark]);
        if (!concern || !remark || Number(remark.community_concern_id) !== Number(concern.id)) {
            return res.status(404).send('Feedback attachment not found.');
        }
        if (!remark.attachment_path || !String(remark.attachment_path).startsWith('community-concern-feedback/')) {
            return res.status(404).send('Feedback attachment not found.');
        }
        return serveFile(res, remark.attachment_path, {
            directoryHints: ['community-concern-feedback'],
            notFoundMessage: 'Feedback attachment not found.',
        });
    });

    // 3. Document Requests Index, Walk-In, Generate, Delete, Pipeline
    app.get('/admin/requests', ...adminGuard('admin.requests'), async (req, res) => {
        const [
            totalRow, pendingRow, approvedTodayRow, overdueRow, activeRow, avgRow,
            tPendingReview, tProcessing, tReady, tCompleted, tRejected,
            dbTypesRes, residentsRes,
        ] = await Promise.all([
            queryOne('SELECT COUNT(*)::int AS cnt FROM document_requests'),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Pending'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Approved' AND updated_at::date = CURRENT_DATE"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Pending' AND created_at < NOW() - INTERVAL '3 days'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status IN ('Pending', 'Under Review', 'Processing', 'Ready')"),
            queryOne("SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0) AS avg_days FROM document_requests WHERE status = 'Approved' AND updated_at IS NOT NULL"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status IN ('Pending', 'Under Review')"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Processing'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Ready'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Completed'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status = 'Rejected'"),
            query('SELECT * FROM document_types ORDER BY name ASC'),
            query("SELECT id, user_id, name, first_name, last_name, middle_name, email, phone_number, purok, street, age, id_type FROM users WHERE LOWER(role) = 'resident' AND LOWER(status) = 'active' ORDER BY name ASC"),
        ]);

        const tabCounts = {
            Pending_Review: tPendingReview?.cnt || 0,
            Processing: tProcessing?.cnt || 0,
            Ready: tReady?.cnt || 0,
            Completed: tCompleted?.cnt || 0,
            Rejected: tRejected?.cnt || 0,
        };

        let autoSelectedStatus = 'Pending_Review';
        if (!req.query.status) {
            if (req.query.search && String(req.query.search).trim() !== '') {
                autoSelectedStatus = 'All';
            } else if (tabCounts.Pending_Review === 0) {
                if (tabCounts.Processing > 0) autoSelectedStatus = 'Processing';
                else if (tabCounts.Ready > 0) autoSelectedStatus = 'Ready';
            }
        }

        const currentStatus = String(req.query.status || autoSelectedStatus);
        const quickFilter = String(req.query.quick_filter || 'all');
        const dbTypes = dbTypesRes.rows.map(hydrateDocumentType);
        const validTypes = dbTypes.length > 0 ? dbTypes.map((d) => d.name) : ['Barangay Clearance', 'Certificate of Residency', 'Certificate of Indigency'];

        const conditions = [];
        const params = [];

        if (currentStatus === 'Pending_Review') {
            conditions.push("r.status IN ('Pending', 'Under Review')");
        } else if (currentStatus !== 'All') {
            params.push(currentStatus);
            conditions.push(`r.status = $${params.length}`);
        }

        if (req.query.quick_filter === 'today') {
            conditions.push('r.created_at::date = CURRENT_DATE');
        } else if (req.query.quick_filter === 'overdue') {
            conditions.push("r.status = 'Pending' AND r.created_at < NOW() - INTERVAL '3 days'");
        } else if (req.query.quick_filter === 'this_week') {
            conditions.push("r.created_at >= date_trunc('week', CURRENT_DATE) AND r.created_at < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'");
        } else if (req.query.quick_filter === 'active') {
            conditions.push("r.status IN ('Pending', 'Under Review', 'Processing', 'Ready')");
        }

        if (req.query.document_type && validTypes.includes(req.query.document_type)) {
            params.push(req.query.document_type);
            const p1 = `$${params.length}`;
            params.push(`%${req.query.document_type}%`);
            const p2 = `$${params.length}`;
            conditions.push(`(r.document_type = ${p1} OR r.document_type ILIKE ${p2} OR CAST(r.documents AS TEXT) ILIKE ${p2})`);
        }

        if (req.query.search && String(req.query.search).trim() !== '') {
            const search = String(req.query.search).trim();
            params.push(`%${search}%`);
            const sp = `$${params.length}`;
            const orParts = [
                `r.tracking_number ILIKE ${sp}`,
                `r.first_name ILIKE ${sp}`,
                `r.last_name ILIKE ${sp}`,
                `r.middle_initial ILIKE ${sp}`,
                `r.resident_email ILIKE ${sp}`,
                `r.contact_number ILIKE ${sp}`,
                `r.document_type ILIKE ${sp}`,
                `CAST(r.documents AS TEXT) ILIKE ${sp}`,
                `r.purpose ILIKE ${sp}`,
                `(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')) ILIKE ${sp}`,
                `u.name ILIKE ${sp}`,
                `u.first_name ILIKE ${sp}`,
                `u.last_name ILIKE ${sp}`,
                `u.email ILIKE ${sp}`,
                `u.user_id ILIKE ${sp}`,
            ];

            const tokens = search.split(/\s+/).filter(Boolean);
            if (tokens.length > 1) {
                const tokenAnd = tokens.map((tok) => {
                    params.push(`%${tok}%`);
                    const tp = `$${params.length}`;
                    return `(r.first_name ILIKE ${tp} OR r.last_name ILIKE ${tp} OR r.middle_initial ILIKE ${tp})`;
                });
                orParts.push(`(${tokenAnd.join(' AND ')})`);
            }

            conditions.push(`(${orParts.join(' OR ')})`);
        }

        const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const page = Math.max(1, Number(req.query.page || 1));
        const perPage = 15;
        const offset = (page - 1) * perPage;

        const fromSql = 'FROM document_requests r LEFT JOIN users u ON u.id = r.user_id';
        const countRes = await queryOne(`SELECT COUNT(*)::int AS cnt ${fromSql} ${whereSql}`, params);
        const rowsRes = await query(
            `SELECT r.*, row_to_json(u.*) AS user_json ${fromSql} ${whereSql} ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, perPage, offset]
        );

        const allRequests = rowsRes.rows.map((r) => {
            const u = r.user_json ? hydrateUser(r.user_json) : null;
            return hydrateDocumentRequest(r, u);
        });
        const total = countRes?.cnt || 0;
        const paginator = {
            currentPage: page,
            lastPage: Math.max(1, Math.ceil(total / perPage)),
            total,
            firstItem: total === 0 ? 0 : offset + 1,
            lastItem: Math.min(offset + perPage, total),
            baseUrl: '/admin/requests',
            query: req.query,
        };

        return renderAdmin(res, 'admin/requests/index', {
            totalRequests: totalRow?.cnt || 0,
            pendingReviews: pendingRow?.cnt || 0,
            approvedToday: approvedTodayRow?.cnt || 0,
            overdueRequests: overdueRow?.cnt || 0,
            activeRequestsCount: activeRow?.cnt || 0,
            avgProcessing: Math.round((Number(avgRow?.avg_days || 0)) * 10) / 10,
            allRequests,
            paginator,
            currentDocType: req.query.document_type || 'All',
            currentStatus,
            quickFilter,
            tabCounts,
            validTypes,
            activeDocTypes: dbTypes.filter((d) => d.is_active),
            residents: residentsRes.rows,
        });
    });

    app.post(
        '/admin/requests/walk-in',
        ...adminGuard('admin.requests.walk-in'),
        uploadImageOrPdf10MB.array('attachments', 10),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            const b = req.body || {};
            if (!b.document_type || !b.purpose) {
                return res.redirectBackWithErrors({ document_type: 'Document type and purpose are required.' }, b, '/admin/requests');
            }

            const trackingNumber = await generateUniqueTrackingNumber();
            let userId = null;
            let firstName, middleInitial, lastName, contactNumber, residentEmail, purok, street, age, idType;
            const city = String(b.city || 'COGON EAST, CARMEN, CEBU').toUpperCase();

            if (b.resident_type === 'registered' && b.user_id) {
                const user = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [b.user_id]);
                if (!user) return res.redirectBackWithErrors({ user_id: 'Resident not found.' }, b, '/admin/requests');
                userId = user.id;
                const nameParts = String(user.name || '').trim().split(/\s+/);
                firstName = String(user.first_name || nameParts[0] || '').toUpperCase();
                middleInitial = String(user.middle_name ? user.middle_name.trim().slice(0, 1) : '').toUpperCase();
                lastName = String(user.last_name || (nameParts.slice(1).join(' ') || user.name || '')).toUpperCase();
                contactNumber = user.phone_number || null;
                residentEmail = user.email ? String(user.email).toLowerCase() : null;
                purok = String(user.purok || '').toUpperCase();
                street = String(user.sitio || user.street || '').toUpperCase();
                age = user.age || null;
                idType = b.id_type || user.id_type || null;
            } else {
                firstName = String(b.first_name || '').trim().toUpperCase();
                middleInitial = b.middle_initial && String(b.middle_initial).trim() ? String(b.middle_initial).trim().toUpperCase() : null;
                lastName = String(b.last_name || '').trim().toUpperCase();
                contactNumber = b.contact_number || null;
                residentEmail = b.resident_email ? String(b.resident_email).trim().toLowerCase() : null;
                purok = b.purok ? String(b.purok).trim().toUpperCase() : null;
                street = b.street ? String(b.street).trim().toUpperCase() : null;
                age = b.age || null;
                idType = b.id_type || null;
            }

            const docType = String(b.document_type).trim();
            const purpose = String(b.purpose).trim().toUpperCase();
            const waiveFee = b.waive_fee === '1' || b.waive_fee === 'true' || b.waive_fee === 'on';
            const fee = waiveFee ? 0 : (b.fee !== undefined && b.fee !== '' ? Number(b.fee) : null);
            const priority = b.priority === 'Urgent' ? 'Urgent' : 'Normal';
            const initialStatus = ['Pending', 'Processing', 'Ready', 'Completed'].includes(b.initial_status) ? b.initial_status : 'Pending';
            const docTypeRecord = await queryOne('SELECT id FROM document_types WHERE name = $1 LIMIT 1', [docType]);

            const documentsJson = [{ type: docType, purpose, fee, is_generated: false }];
            const attachmentsData = [];
            for (const file of req.files || []) {
                const filePath = await uploadBuffer(file.buffer, 'attachments', file.originalname, file.mimetype);
                const ext = (file.originalname.split('.').pop() || '').toLowerCase();
                const fileType = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? 'image' : 'document';
                attachmentsData.push({
                    file_path: filePath,
                    file_name: file.originalname,
                    doc_type: 'Walk-in Attachment',
                    file_type: fileType,
                    file_size: file.size,
                });
            }

            const inserted = await queryOne(
                `INSERT INTO document_requests (
                    user_id, tracking_number, first_name, middle_initial, last_name,
                    contact_number, resident_email, purok, street, city, age, id_type,
                    document_type_id, document_type, purpose, fee, priority, status,
                    documents, attachments, is_generated, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18,
                    $19::jsonb, $20::jsonb, FALSE, NOW(), NOW()
                ) RETURNING *`,
                [
                    userId, trackingNumber, firstName, middleInitial, lastName,
                    contactNumber, residentEmail, purok, street, city, age, idType,
                    docTypeRecord?.id || null, docType, purpose, fee, priority, initialStatus,
                    JSON.stringify(documentsJson),
                    attachmentsData.length > 0 ? JSON.stringify(attachmentsData) : null,
                ]
            );

            const hydrated = hydrateDocumentRequest(inserted);
            await ActivityLog.record(
                'walkin_request_created',
                `Admin created walk-in request #${hydrated.tracking_number} (${hydrated.document_type}) for ${hydrated.resident_name}.`,
                req.user.id,
                req
            );

            await broadcastRealtimeEvent('request.created', {
                id: hydrated.id,
                tracking_number: hydrated.tracking_number,
                status: hydrated.status,
                applicant: hydrated.resident_name,
                document_type: hydrated.document_type,
                message: `New Walk-in Request #${hydrated.tracking_number} created.`,
            });

            return res.redirectWithFlash('/admin/requests', 'success', `Walk-in request #${hydrated.tracking_number} created successfully with status '${hydrated.status}'.`);
        }
    );

    app.get('/admin/requests/generate/:id', ...adminGuard('admin.requests.generate'), async (req, res) => {
        const row = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!row) return res.status(404).send('Document request not found.');

        const nextStatus = ['Pending', 'Under Review'].includes(row.status) ? 'Processing' : row.status;
        const updated = await queryOne(
            'UPDATE document_requests SET is_generated = TRUE, status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
            [nextStatus, row.id]
        );
        const docReq = hydrateDocumentRequest(updated);

        await ActivityLog.record(
            'document_generated',
            `Generated Word document for request #${docReq.tracking_number} (${docReq.document_type}).`,
            req.user.id,
            req
        );

        const requestedDocType = req.query.doc_type ? String(req.query.doc_type) : null;
        const docsList = docReq.documents_list;

        if (requestedDocType) {
            const matchItem = docsList.find((d) => d.type === requestedDocType);
            const result = await generateWordDocumentBuffer(docReq, requestedDocType, matchItem?.purpose || docReq.purpose);
            res.setHeader('Content-Type', result.contentType);
            res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
            return res.send(result.buffer);
        }

        if (docsList.length > 1) {
            const zipRes = await bundleMultipleDocumentsZip(docReq, docsList);
            res.setHeader('Content-Type', zipRes.contentType);
            res.setHeader('Content-Disposition', `attachment; filename="${zipRes.fileName}"`);
            return res.send(zipRes.buffer);
        }

        const singleDocType = docsList[0]?.type || docReq.document_type;
        const singlePurpose = docsList[0]?.purpose || docReq.purpose;
        const result = await generateWordDocumentBuffer(docReq, singleDocType, singlePurpose);
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
        return res.send(result.buffer);
    });

    app.delete('/admin/requests/bulk-delete', ...adminGuard('admin.requests.bulk-delete'), async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        if (ids.length === 0) return res.redirectBackWithErrors({ ids: 'Select at least one request.' }, false, '/admin/requests');
        const delRes = await query('DELETE FROM document_requests WHERE id = ANY($1) RETURNING id', [ids]);
        const count = delRes.rowCount || 0;
        await ActivityLog.record('requests_bulk_deleted', `Permanently deleted ${count} document request(s).`, req.user.id, req);
        return res.redirectWithFlash('/admin/requests', 'success', `Permanently deleted ${count} document request(s).`);
    });

    app.get('/admin/requests/:id', ...adminGuard('admin.requests.show'), async (req, res) => {
        const param = req.params.id;
        const found = /^\d+$/.test(param)
            ? await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [Number(param)])
            : await queryOne('SELECT * FROM document_requests WHERE tracking_number = $1 LIMIT 1', [param]);
        if (found) {
            return res.redirect(`/admin/requests?status=All&search=${encodeURIComponent(found.tracking_number)}`);
        }
        return res.redirectWithFlash('/admin/requests', 'info', `Request #${param} was not found or has already been cleared.`);
    });

    app.delete('/admin/requests/:id', ...adminGuard('admin.requests.destroy'), async (req, res) => {
        const found = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!found) return res.status(404).send('Not found.');
        await query('DELETE FROM document_requests WHERE id = $1', [found.id]);
        await ActivityLog.record('request_deleted', `Permanently deleted document request #${found.tracking_number}.`, req.user.id, req);
        return res.redirectWithFlash('/admin/requests', 'success', 'Request deleted permanently.');
    });

    async function handleUpdateRequest(req, res) {
        const existing = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!existing) return res.status(404).json({ success: false, message: 'Request not found.' });

        const b = req.body || {};
        if (!b.first_name || !b.last_name) {
            return res.redirectBackWithErrors({ first_name: 'First name and last name are required.' }, b, '/admin/requests');
        }

        const fee = b.fee !== undefined && b.fee !== '' && b.fee !== null ? Number(b.fee) : null;
        const firstName = String(b.first_name).trim().toUpperCase();
        const lastName = String(b.last_name).trim().toUpperCase();
        const middleInitial = b.middle_initial && String(b.middle_initial).trim() ? String(b.middle_initial).trim().toUpperCase() : null;
        let docType = b.document_type || existing.document_type;
        let purpose = b.purpose && String(b.purpose).trim() ? String(b.purpose).trim().toUpperCase() : existing.purpose;

        if (b.documents_json) {
            try {
                const decoded = JSON.parse(b.documents_json);
                if (Array.isArray(decoded) && decoded.length > 0) {
                    docType = decoded[0]?.type || docType;
                    if (decoded[0]?.purpose) purpose = String(decoded[0].purpose).trim().toUpperCase();
                }
            } catch (_) {}
        } else if (Array.isArray(b.doc_types) && b.doc_types.length > 0) {
            docType = String(b.doc_types[0] || docType).trim();
            if (b.doc_purposes?.[0]) purpose = String(b.doc_purposes[0]).trim().toUpperCase();
        }

        const docTypeRec = await queryOne('SELECT id FROM document_types WHERE name = $1 LIMIT 1', [docType]);
        const docsJson = [{ type: docType, purpose, fee, is_generated: Boolean(existing.is_generated) }];

        const updated = await queryOne(
            `UPDATE document_requests SET
                first_name = $1, last_name = $2, middle_initial = $3, age = $4,
                contact_number = $5, resident_email = $6, fee = $7, id_type = $8,
                document_type = $9, document_type_id = $10, purpose = $11,
                documents = $12::jsonb, updated_at = NOW()
             WHERE id = $13 RETURNING *`,
            [
                firstName,
                lastName,
                middleInitial,
                b.age || null,
                b.contact_number || null,
                b.resident_email || null,
                fee,
                b.id_type && String(b.id_type).trim() ? b.id_type : null,
                docType,
                docTypeRec?.id || null,
                purpose,
                JSON.stringify(docsJson),
                existing.id,
            ]
        );

        if (existing.user_id && b.id_type) {
            await query("UPDATE users SET id_type = COALESCE(NULLIF(id_type, ''), $1), updated_at = NOW() WHERE id = $2", [b.id_type, existing.user_id]);
        }

        await ActivityLog.record('request_updated', `Updated document request #${updated.tracking_number} (${updated.document_type}).`, req.user.id, req);

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({
                success: true,
                message: `Request #${updated.tracking_number} updated successfully.`,
                request: {
                    id: Number(updated.id),
                    tracking_number: updated.tracking_number,
                    first_name: updated.first_name,
                    last_name: updated.last_name,
                    middle_initial: updated.middle_initial,
                    full_name: `${updated.first_name} ${updated.middle_initial ? updated.middle_initial + ' ' : ''}${updated.last_name}`.trim(),
                    age: updated.age,
                    contact_number: updated.contact_number,
                    resident_email: updated.resident_email,
                    contact_display: updated.resident_email || updated.contact_number || '—',
                    fee: updated.fee !== null ? Number(updated.fee) : null,
                    fee_formatted: updated.fee !== null && Number(updated.fee) > 0 ? `₱${Number(updated.fee).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'FREE',
                    id_type: updated.id_type,
                    document_type: updated.document_type,
                    purpose: updated.purpose,
                },
            });
        }
        return res.redirectWithFlash('/admin/requests', 'success', 'Request updated successfully.');
    }

    app.patch('/admin/requests/:id/update', ...adminGuard('admin.requests.update'), handleUpdateRequest);
    app.post('/admin/requests/:id/update', ...adminGuard('admin.requests.update'), handleUpdateRequest);

    app.patch('/admin/requests/:id/fee', ...adminGuard('admin.requests.updateFee'), async (req, res) => {
        const row = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!row) return res.status(404).send('Not found.');
        const fee = req.body?.fee !== undefined && req.body.fee !== '' && req.body.fee !== null ? Number(req.body.fee) : null;

        let docs = row.documents;
        if (typeof docs === 'string') {
            try { docs = JSON.parse(docs); } catch (_) { docs = null; }
        }
        if (Array.isArray(docs)) {
            docs = docs.map((d) => (typeof d === 'object' && d ? { ...d, fee } : d));
        }

        await query('UPDATE document_requests SET fee = $1, documents = $2::jsonb, updated_at = NOW() WHERE id = $3', [
            fee,
            docs ? JSON.stringify(docs) : null,
            row.id,
        ]);

        const feeText = fee !== null ? `₱${fee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'To be settled';
        await ActivityLog.record('request_fee_updated', `Updated fee for request #${row.tracking_number} to ${feeText}.`, req.user.id, req);
        return res.redirectWithFlash('/admin/requests', 'success', `Fee for request #${row.tracking_number} updated to ${feeText}.`);
    });

    app.patch('/admin/requests/:id/accept', ...adminGuard('admin.requests.accept'), async (req, res) => {
        const row = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!row) return res.status(404).json({ success: false, message: 'Not found.' });

        const wasAcceptable = ['Pending', 'Under Review'].includes(row.status);
        let fee = row.fee;
        let docs = row.documents;
        if (typeof docs === 'string') {
            try { docs = JSON.parse(docs); } catch (_) { docs = null; }
        }

        if (req.body?.fee !== undefined && req.body.fee !== '' && req.body.fee !== null) {
            fee = Number(req.body.fee);
            if (Array.isArray(docs)) {
                docs = docs.map((d) => (typeof d === 'object' && d ? { ...d, fee } : d));
            }
        }

        const nextStatus = wasAcceptable ? 'Processing' : row.status;
        const updatedRow = await queryOne(
            'UPDATE document_requests SET fee = $1, documents = $2::jsonb, status = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
            [fee, docs ? JSON.stringify(docs) : null, nextStatus, row.id]
        );
        const docRequest = hydrateDocumentRequest(updatedRow);
        const residentUser = await resolveResidentUser(docRequest);
        const recipientEmail = String(docRequest.resident_email || residentUser?.email || '').trim();

        let emailSent = false;
        let portalNotified = false;

        if (wasAcceptable) {
            if (recipientEmail) {
                try {
                    await sendDocumentAcceptedEmail(recipientEmail, docRequest);
                    emailSent = true;
                } catch (err) {
                    console.error(`Request accepted email error for #${docRequest.tracking_number}:`, err.message);
                }
            }
            if (residentUser) {
                try {
                    await NotificationService.notifyUser(residentUser.id, 'App\\Notifications\\DocumentAcceptedNotification', {
                        request_id: docRequest.id,
                        tracking_number: docRequest.tracking_number,
                        document_type: docRequest.document_type,
                        status: 'Processing',
                        message: `Your request for ${docRequest.document_type} (#${docRequest.tracking_number}) has been accepted and is now being processed.`,
                        link: '/resident/track-request',
                    });
                    portalNotified = true;
                } catch (_) {}
            }
        }

        await ActivityLog.record('request_accepted', `Accepted document request #${docRequest.tracking_number} (${docRequest.document_type}) for ${docRequest.resident_name}.`, req.user.id, req);

        await broadcastRealtimeEvent('request.status_changed', {
            id: docRequest.id,
            tracking_number: docRequest.tracking_number,
            status: docRequest.status,
            applicant: docRequest.resident_name,
            user_id: residentUser?.id || docRequest.user_id,
            document_type: docRequest.document_type,
            message: `Your request #${docRequest.tracking_number} (${docRequest.document_type}) has been accepted and is now Processing.`,
        });

        let statusMessage = 'Request accepted and moved to Processing.';
        if (wasAcceptable) {
            if (emailSent && portalNotified) statusMessage = 'Request accepted and moved to Processing. Resident notified via email and portal.';
            else if (portalNotified) statusMessage = 'Request accepted and moved to Processing. Resident notified in portal.';
            else if (emailSent) statusMessage = 'Request accepted and moved to Processing. Email notification sent to resident.';
        }

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, status: 'Processing', email_sent: emailSent, portal_notified: portalNotified, message: statusMessage });
        }
        return res.redirectWithFlash('/admin/requests', 'success', statusMessage);
    });

    app.patch('/admin/requests/:id/reject', ...adminGuard('admin.requests.reject'), async (req, res) => {
        const row = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!row) return res.status(404).json({ success: false, message: 'Not found.' });
        const docRequest = hydrateDocumentRequest(row);
        const residentUser = await resolveResidentUser(docRequest);
        const recipientEmail = String(docRequest.resident_email || residentUser?.email || '').trim();

        const rawReason = String(req.body?.reason || req.body?.rejection_reason || '').trim();
        const reason = rawReason ? rawReason.slice(0, 1000) : null;
        let notifMessage = `Your document request #${docRequest.tracking_number} (${docRequest.document_type}) was rejected and removed.`;
        if (reason) notifMessage += ` Reason: ${reason}`;

        let emailSent = false;
        let emailError = null;
        if (recipientEmail) {
            try {
                await sendDocumentRejectedEmail(recipientEmail, {
                    trackingNumber: docRequest.tracking_number,
                    documentType: docRequest.document_type,
                    residentName: docRequest.resident_name,
                    purpose: docRequest.purpose,
                    reason,
                });
                emailSent = true;
            } catch (err) {
                emailError = err.message;
            }
        } else {
            emailError = 'No resident email address is attached to this request.';
        }

        let portalNotified = false;
        if (residentUser) {
            try {
                let msg = `Your request for ${docRequest.document_type} (#${docRequest.tracking_number}) has been rejected.`;
                if (reason) msg += ` Reason: ${reason}`;
                await NotificationService.notifyUser(residentUser.id, 'App\\Notifications\\DocumentRejectedNotification', {
                    tracking_number: docRequest.tracking_number,
                    document_type: docRequest.document_type,
                    status: 'Rejected',
                    reason,
                    message: msg,
                });
                portalNotified = true;
            } catch (_) {}
        }

        await broadcastRealtimeEvent('request.status_changed', {
            id: docRequest.id,
            tracking_number: docRequest.tracking_number,
            status: 'Rejected',
            applicant: docRequest.resident_name,
            user_id: residentUser?.id || docRequest.user_id,
            document_type: docRequest.document_type,
            message: notifMessage,
        });

        await query('DELETE FROM document_requests WHERE id = $1', [docRequest.id]);
        await ActivityLog.record('request_rejected', `Rejected and deleted document request #${docRequest.tracking_number} (${docRequest.document_type}) for ${docRequest.resident_name}.`, req.user.id, req);

        let statusMessage = `Request #${docRequest.tracking_number} has been rejected and deleted.`;
        if (emailSent && portalNotified) statusMessage = `Request #${docRequest.tracking_number} has been rejected and deleted. Resident notified via email and portal.`;
        else if (emailSent) statusMessage = `Request #${docRequest.tracking_number} has been rejected and deleted. Email notification sent to resident.`;
        else if (portalNotified) statusMessage = `Request #${docRequest.tracking_number} has been rejected and deleted. Resident notified in portal.`;

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, email_sent: emailSent, email_error: emailError, portal_notified: portalNotified, message: statusMessage });
        }
        req.flash('success', statusMessage);
        if (!emailSent && emailError) req.flash('warning', `Email notification could not be sent: ${emailError}`);
        return res.redirect('/admin/requests');
    });

    app.patch('/admin/requests/:id/ready', ...adminGuard('admin.requests.ready'), async (req, res) => {
        const updated = await queryOne("UPDATE document_requests SET status = 'Ready', updated_at = NOW() WHERE id = $1 RETURNING *", [req.params.id]);
        if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
        const docRequest = hydrateDocumentRequest(updated);
        const residentUser = await resolveResidentUser(docRequest);

        await ActivityLog.record('request_ready', `Marked request #${docRequest.tracking_number} as Ready for Pick-up.`, req.user.id, req);

        if (docRequest.resident_email) {
            try { await sendDocumentReadyEmail(docRequest.resident_email, docRequest); } catch (_) {}
        }
        if (residentUser) {
            await NotificationService.notifyUser(residentUser.id, 'App\\Notifications\\DocumentReadyNotification', {
                tracking_number: docRequest.tracking_number,
                document_type: docRequest.document_type,
                message: `Your ${docRequest.document_type} is ready for pick-up!`,
            });
        }

        await broadcastRealtimeEvent('request.status_changed', {
            id: docRequest.id,
            tracking_number: docRequest.tracking_number,
            status: 'Ready',
            applicant: docRequest.resident_name,
            user_id: residentUser?.id || docRequest.user_id,
            document_type: docRequest.document_type,
            message: `Request #${docRequest.tracking_number} is Ready for Pick-up!`,
        });

        const msg = 'Document marked as Ready for Pick-up! Notification sent to the resident.';
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, status: 'Ready', message: msg });
        }
        return res.redirectWithFlash('/admin/requests', 'success', msg);
    });

    app.patch('/admin/requests/:id/complete', ...adminGuard('admin.requests.complete'), async (req, res) => {
        const updated = await queryOne("UPDATE document_requests SET status = 'Completed', updated_at = NOW() WHERE id = $1 RETURNING *", [req.params.id]);
        if (!updated) return res.status(404).json({ success: false, message: 'Not found.' });
        const docRequest = hydrateDocumentRequest(updated);
        const residentUser = await resolveResidentUser(docRequest);

        await ActivityLog.record('request_completed', `Marked request #${docRequest.tracking_number} as Completed (claimed by resident).`, req.user.id, req);

        await broadcastRealtimeEvent('request.status_changed', {
            id: docRequest.id,
            tracking_number: docRequest.tracking_number,
            status: 'Completed',
            applicant: docRequest.resident_name,
            user_id: residentUser?.id || docRequest.user_id,
            document_type: docRequest.document_type,
            message: `Request #${docRequest.tracking_number} marked as Completed.`,
        });

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({ success: true, status: 'Completed', message: 'Document marked as Completed!' });
        }
        return res.redirectWithFlash('/admin/requests', 'success', 'Document marked as Completed!');
    });

    // 4. Account Approvals
    app.get('/admin/account-approvals', ...adminGuard('admin.approvals'), async (req, res) => {
        const [pCnt, aCnt, rCnt] = await Promise.all([
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE status = 'pending_approval'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE status = 'active'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE status = 'rejected'"),
        ]);
        const tabCounts = { pending_approval: pCnt?.cnt || 0, active: aCnt?.cnt || 0, rejected: rCnt?.cnt || 0 };
        const currentStatus = String(req.query.status || 'pending_approval');

        const params = [currentStatus];
        let sql = 'SELECT * FROM users WHERE status = $1';
        if (req.query.id_type && String(req.query.id_type).trim() !== '') {
            params.push(String(req.query.id_type).trim());
            sql += ` AND id_type = $${params.length}`;
        }
        sql += ' ORDER BY created_at DESC';

        const { rows } = await query(sql, params);
        return renderAdmin(res, 'admin/account_approvals', {
            pendingUsers: rows.map(hydrateUser),
            tabCounts,
            currentStatus,
        });
    });

    app.patch('/admin/account-approvals/:id/approve', ...adminGuard('admin.approvals.approve'), async (req, res) => {
        const user = await queryOne("UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1 RETURNING *", [req.params.id]);
        if (!user) return res.status(404).send('User not found.');
        await ActivityLog.record('account_approved', `Approved resident account for ${user.name} (ID: ${user.user_id}).`, req.user.id, req);
        if (user.email) {
            try { await sendAccountApprovedEmail(user); } catch (err) { console.error('Approval email error:', err.message); }
        }
        if (user.phone_number) {
            await sendSms(user.phone_number, `Hello ${user.name}, your E-Barangay account has been approved by the Admin! You can now log in to the website.`);
        }
        return res.redirectWithFlash('/admin/account-approvals', 'success', 'Resident account approved successfully. A notification has been sent.');
    });

    app.patch('/admin/account-approvals/:id/reject', ...adminGuard('admin.approvals.reject'), async (req, res) => {
        const user = await queryOne("UPDATE users SET status = 'rejected', updated_at = NOW() WHERE id = $1 RETURNING *", [req.params.id]);
        if (!user) return res.status(404).send('User not found.');
        await ActivityLog.record('account_rejected', `Rejected resident account for ${user.name} (ID: ${user.user_id}).`, req.user.id, req);
        if (user.email) {
            try { await sendAccountRejectedEmail(user.email, user.name); } catch (err) { console.error('Rejection email error:', err.message); }
        }
        if (user.phone_number) {
            await sendSms(user.phone_number, `Hello ${user.name}, your E-Barangay registration was not approved. Please contact the barangay hall or re-submit valid requirements.`);
        }
        return res.redirectWithFlash('/admin/account-approvals', 'success', 'Resident account rejected successfully.');
    });

    app.post('/admin/account-approvals/bulk-approve', ...adminGuard('admin.approvals.bulk-approve'), async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        if (ids.length === 0) return res.redirectBackWithErrors({ ids: 'Select at least one user.' }, false, '/admin/account-approvals');
        const { rows: users } = await query("UPDATE users SET status = 'active', updated_at = NOW() WHERE id = ANY($1) RETURNING *", [ids]);
        for (const u of users) {
            if (u.email) { try { await sendAccountApprovedEmail(u); } catch (_) {} }
            if (u.phone_number) { try { await sendSms(u.phone_number, `Hello ${u.name}, your E-Barangay account has been approved by the Admin! You can now log in to the website.`, 5000); } catch (_) {} }
        }
        await ActivityLog.record('accounts_bulk_approved', `Approved ${users.length} resident account(s) in bulk.`, req.user.id, req);
        return res.redirectWithFlash('/admin/account-approvals', 'success', `Successfully approved ${users.length} resident account(s).`);
    });

    app.post('/admin/account-approvals/bulk-reject', ...adminGuard('admin.approvals.bulk-reject'), async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        if (ids.length === 0) return res.redirectBackWithErrors({ ids: 'Select at least one user.' }, false, '/admin/account-approvals');
        const { rows: users } = await query("UPDATE users SET status = 'rejected', updated_at = NOW() WHERE id = ANY($1) RETURNING *", [ids]);
        for (const u of users) {
            if (u.email) { try { await sendAccountRejectedEmail(u.email, u.name); } catch (_) {} }
            if (u.phone_number) { try { await sendSms(u.phone_number, `Hello ${u.name}, your E-Barangay registration was not approved. Please contact the barangay hall or re-submit valid requirements.`, 5000); } catch (_) {} }
        }
        await ActivityLog.record('accounts_bulk_rejected', `Rejected ${users.length} resident account(s) in bulk.`, req.user.id, req);
        return res.redirectWithFlash('/admin/account-approvals', 'success', `Successfully rejected ${users.length} resident account(s).`);
    });

    // 5. User Management
    app.get('/admin/users', ...adminGuard('admin.users'), async (req, res) => {
        const [totalRow, activeRow, newRegRow, adminRow, residentRow, pendingNewRow] = await Promise.all([
            queryOne('SELECT COUNT(*)::int AS cnt FROM users'),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE LOWER(status) = 'active'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE role = 'Admin'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE role = 'Resident'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE status IN ('pending_approval', 'Pending', 'pending') OR date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)"),
        ]);

        const tabCounts = {
            All: totalRow?.cnt || 0,
            Resident: residentRow?.cnt || 0,
            Admin: adminRow?.cnt || 0,
            Pending: pendingNewRow?.cnt || 0,
        };

        const currentRole = String(req.query.role || 'All');
        const currentStatus = String(req.query.status || 'All');
        const currentSort = String(req.query.sort || 'newest');

        const conditions = [];
        const params = [];

        if (currentRole === 'Resident' || currentRole === 'Admin') {
            params.push(currentRole);
            conditions.push(`role = $${params.length}`);
        } else if (currentRole === 'Pending' || currentRole === 'Pending / New') {
            conditions.push("(status IN ('pending_approval', 'Pending', 'pending') OR date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE))");
        }

        if (currentStatus !== 'All') {
            if (currentStatus === 'active') conditions.push("LOWER(status) = 'active'");
            else if (currentStatus === 'inactive') conditions.push("LOWER(status) = 'inactive'");
            else if (currentStatus === 'pending_approval') conditions.push("status IN ('pending_approval', 'Pending', 'pending')");
        }

        if (req.query.search && String(req.query.search).trim() !== '') {
            params.push(`%${String(req.query.search).trim()}%`);
            const sp = `$${params.length}`;
            conditions.push(`(name ILIKE ${sp} OR email ILIKE ${sp} OR CAST(id AS TEXT) ILIKE ${sp} OR user_id ILIKE ${sp})`);
        }

        const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        let orderSql = 'ORDER BY created_at DESC';
        if (currentSort === 'oldest') orderSql = 'ORDER BY created_at ASC';
        else if (currentSort === 'name_asc') orderSql = 'ORDER BY name ASC';
        else if (currentSort === 'name_desc') orderSql = 'ORDER BY name DESC';

        const { rows } = await query(`SELECT * FROM users ${whereSql} ${orderSql}`, params);

        return renderAdmin(res, 'admin/users/users_list', {
            pageTitle: 'User Management',
            totalUsers: totalRow?.cnt || 0,
            activeUsers: activeRow?.cnt || 0,
            newRegistrations: newRegRow?.cnt || 0,
            adminUsers: adminRow?.cnt || 0,
            allUsers: rows.map(hydrateUser),
            currentRole,
            currentStatus,
            currentSort,
            tabCounts,
        });
    });

    app.post('/admin/users', ...adminGuard('admin.users.store'), async (req, res) => {
        const b = req.body || {};
        if (!b.name || !b.email || !b.password || String(b.password).length < 8 || !['Admin', 'Resident'].includes(b.role)) {
            return res.redirectBackWithErrors({ email: 'Please fill out all required fields (minimum 8-char password).' }, b, '/admin/users');
        }
        const dup = await queryOne('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [b.email]);
        if (dup) return res.redirectBackWithErrors({ email: 'This email is already registered.' }, b, '/admin/users');

        const fullName = String(b.name).trim().toUpperCase();
        const parts = fullName.split(/\s+/);
        const rolePrefix = b.role === 'Admin' ? 'ADM-' : 'USR-';
        const userIdCode = rolePrefix + String(crypto.randomInt(10000, 100000));
        const hashed = await hashSecret(b.password);

        const created = await queryOne(
            `INSERT INTO users (user_id, name, first_name, last_name, email, role, status, password, email_verified_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW()) RETURNING *`,
            [userIdCode, fullName, parts[0] || fullName, parts.slice(1).join(' '), b.email, b.role, b.status || 'active', hashed]
        );

        await ActivityLog.record('user_created', `Created new ${created.role} user: ${created.name} (${created.email}).`, req.user.id, req);
        return res.redirectWithFlash('/admin/users', 'success', `User "${created.name}" has been created successfully.`);
    });

    app.delete('/admin/users/bulk-delete', ...adminGuard('admin.users.bulk-delete'), async (req, res) => {
        const rawIds = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        const ids = rawIds.filter((id) => id !== Number(req.user.id));
        if (ids.length === 0) {
            return res.redirectBackWithErrors({ error: 'No valid users could be deleted (cannot delete yourself).' }, false, '/admin/users');
        }
        const { rows: users } = await query('SELECT id, profile_picture FROM users WHERE id = ANY($1)', [ids]);
        for (const u of users) {
            if (u.profile_picture) await deleteFile(u.profile_picture, ['profile_pictures']);
        }
        await query('DELETE FROM users WHERE id = ANY($1)', [ids]);
        await ActivityLog.record('users_bulk_deleted', `Permanently deleted ${users.length} user(s).`, req.user.id, req);
        return res.redirectWithFlash('/admin/users', 'success', `Permanently deleted ${users.length} user(s).`);
    });

    app.get('/admin/users/:id', ...adminGuard('admin.users.view'), async (req, res) => {
        const u = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!u) return res.status(404).json({ error: 'User not found' });
        const hydrated = hydrateUser(u);
        delete hydrated.password;
        delete hydrated.security_pin;
        delete hydrated.remember_token;
        return res.json(hydrated);
    });

    app.patch('/admin/users/:id/update', ...adminGuard('admin.users.update'), async (req, res) => {
        const existing = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!existing) return res.status(404).send('User not found.');
        const b = req.body || {};
        const oldRole = existing.role;
        const fullName = String(b.name || existing.name).trim().toUpperCase();
        const parts = fullName.split(/\s+/);
        let ageVal = existing.age;
        if (b.birthdate) {
            const bd = new Date(b.birthdate);
            if (!Number.isNaN(bd.getTime())) ageVal = Math.floor((Date.now() - bd.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        }

        await query(
            `UPDATE users SET
                name = $1, first_name = $2, last_name = $3, email = $4, role = $5,
                phone_number = $6, gender = $7, birthdate = $8, age = $9, civil_status = $10,
                occupation = $11, nationality = $12, purok = $13, sitio = $14,
                barangay_address = $15, municipality = $16, province = $17, zip_code = $18,
                status = $19, updated_at = NOW()
             WHERE id = $20`,
            [
                fullName,
                parts[0] || existing.first_name,
                parts.length > 1 ? parts.slice(1).join(' ') : existing.last_name,
                b.email || existing.email,
                b.role || existing.role,
                b.phone_number !== undefined ? (b.phone_number || null) : existing.phone_number,
                b.gender !== undefined ? (b.gender || null) : existing.gender,
                b.birthdate || existing.birthdate,
                ageVal,
                b.civil_status !== undefined ? (b.civil_status || null) : existing.civil_status,
                b.occupation !== undefined ? (b.occupation || null) : existing.occupation,
                b.nationality !== undefined ? (b.nationality || null) : existing.nationality,
                b.purok !== undefined ? (b.purok || null) : existing.purok,
                b.sitio !== undefined ? (b.sitio || null) : existing.sitio,
                b.barangay_address !== undefined ? (b.barangay_address || null) : existing.barangay_address,
                b.municipality !== undefined ? (b.municipality || null) : existing.municipality,
                b.province !== undefined ? (b.province || null) : existing.province,
                b.zip_code !== undefined ? (b.zip_code || null) : existing.zip_code,
                b.status || existing.status,
                existing.id,
            ]
        );

        await ActivityLog.record('user_updated', `Updated user ${fullName}: role changed from ${oldRole} to ${b.role || existing.role}.`, req.user.id, req);
        return res.redirectWithFlash('/admin/users', 'success', `User "${fullName}" has been updated successfully.`);
    });

    app.patch('/admin/users/:id/toggle-status', ...adminGuard('admin.users.toggle-status'), async (req, res) => {
        const u = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!u) return res.status(404).send('User not found.');
        const isActive = String(u.status || '').toLowerCase() === 'active';
        const nextStatus = isActive ? 'inactive' : 'active';
        await query('UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2', [nextStatus, u.id]);
        const action = isActive ? 'user_deactivated' : 'user_reactivated';
        const desc = `${isActive ? 'Deactivated' : 'Reactivated'} account for user ${u.name}.`;
        await ActivityLog.record(action, desc, req.user.id, req);
        const msg = isActive ? `User "${u.name}" has been deactivated.` : `User "${u.name}" has been reactivated.`;
        return res.redirectWithFlash('/admin/users', 'success', msg);
    });

    app.delete('/admin/users/:id', ...adminGuard('admin.users.destroy'), async (req, res) => {
        if (Number(req.params.id) === Number(req.user.id)) {
            return res.redirectBackWithErrors({ error: 'You cannot delete your own admin account.' }, false, '/admin/users');
        }
        const u = await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!u) return res.status(404).send('User not found.');
        if (u.profile_picture) await deleteFile(u.profile_picture, ['profile_pictures']);
        await query('DELETE FROM users WHERE id = $1', [u.id]);
        await ActivityLog.record('user_deleted', `Permanently deleted user ${u.name} (ID: ${u.id}).`, req.user.id, req);
        return res.redirectWithFlash('/admin/users', 'success', `User "${u.name}" has been permanently deleted.`);
    });

    // 6. Reports & Profile
    app.get('/admin/reports', ...adminGuard('admin.reports'), (req, res) => {
        return renderAdmin(res, 'admin/reports/reports_overview');
    });

    app.get('/admin/profile', ...adminGuard('admin.profile'), (req, res) => {
        return renderAdmin(res, 'admin/profile/profile_settings', { user: req.user });
    });

    app.post(
        '/admin/profile/update',
        ...adminGuard('admin.profile.update'),
        uploadImage2MB.single('profile_picture'),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            const b = req.body || {};
            const user = req.user;
            if (!b.name || !b.email) {
                return res.redirectBackWithErrors({ name: 'Name and email are required.' }, b, '/admin/profile');
            }

            let newPassword = user.password;
            if (b.new_password && String(b.new_password).trim() !== '') {
                if (!(await verifySecret(String(b.current_password || ''), user.password))) {
                    return res.redirectBackWithErrors({ current_password: 'The current password you entered is incorrect.' }, b, '/admin/profile');
                }
                if (String(b.new_password).length < 8 || b.new_password !== b.new_password_confirmation) {
                    return res.redirectBackWithErrors({ new_password: 'New password must be at least 8 characters and match confirmation.' }, b, '/admin/profile');
                }
                newPassword = await hashSecret(b.new_password);
            }

            let profilePic = user.profile_picture;
            if (b.remove_profile_picture === '1') {
                if (profilePic) await deleteFile(profilePic, ['profile_pictures']);
                profilePic = null;
            } else if (req.file) {
                if (profilePic) await deleteFile(profilePic, ['profile_pictures']);
                profilePic = await uploadBuffer(req.file.buffer, 'profile_pictures', req.file.originalname, req.file.mimetype);
            }

            await query(
                'UPDATE users SET name = $1, email = $2, contact_number = $3, password = $4, profile_picture = $5, updated_at = NOW() WHERE id = $6',
                [b.name, b.email, b.contact_number || null, newPassword, profilePic, user.id]
            );

            await ActivityLog.record('profile_updated', `Admin ${b.name} updated their profile settings.`, user.id, req);
            return res.redirectWithFlash('/admin/profile', 'success', 'Profile updated successfully!');
        }
    );

    // 7. Activity Logs
    app.get('/admin/activity-logs', ...adminGuard('admin.activity-logs'), async (req, res) => {
        const conditions = [];
        const params = [];
        if (req.query.action) {
            params.push(String(req.query.action));
            conditions.push(`l.action = $${params.length}`);
        }
        if (req.query.date_from) {
            params.push(String(req.query.date_from));
            conditions.push(`l.created_at::date >= $${params.length}::date`);
        }
        if (req.query.date_to) {
            params.push(String(req.query.date_to));
            conditions.push(`l.created_at::date <= $${params.length}::date`);
        }
        if (req.query.search && String(req.query.search).trim() !== '') {
            params.push(`%${String(req.query.search).trim()}%`);
            const sp = `$${params.length}`;
            conditions.push(`(l.description ILIKE ${sp} OR l.action ILIKE ${sp} OR u.name ILIKE ${sp})`);
        }

        const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const page = Math.max(1, Number(req.query.page || 1));
        const perPage = 25;
        const offset = (page - 1) * perPage;

        const [countRow, rowsRes, actionRes] = await Promise.all([
            queryOne(`SELECT COUNT(*)::int AS cnt FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id ${whereSql}`, params),
            query(
                `SELECT l.*, u.name AS user_name, u.role AS user_role, u.email AS user_email
                 FROM activity_logs l
                 LEFT JOIN users u ON u.id = l.user_id
                 ${whereSql}
                 ORDER BY l.created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                [...params, perPage, offset]
            ),
            query('SELECT DISTINCT action FROM activity_logs ORDER BY action ASC'),
        ]);

        const logs = rowsRes.rows.map((r) => ({
            ...r,
            user: r.user_name ? { id: Number(r.user_id), name: r.user_name, role: r.user_role, email: r.user_email } : null,
        }));
        const total = countRow?.cnt || 0;
        const paginator = {
            currentPage: page,
            lastPage: Math.max(1, Math.ceil(total / perPage)),
            total,
            firstItem: total === 0 ? 0 : offset + 1,
            lastItem: Math.min(offset + perPage, total),
            baseUrl: '/admin/activity-logs',
            query: req.query,
        };

        return renderAdmin(res, 'admin/activity_logs', {
            logs,
            paginator,
            actionTypes: actionRes.rows.map((r) => r.action),
        });
    });

    app.delete('/admin/activity-logs/bulk-delete', ...adminGuard('admin.activity-logs.bulk-delete'), async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        if (ids.length === 0) return res.redirectBackWithErrors({ ids: 'Select logs to delete.' }, false, '/admin/activity-logs');
        const del = await query('DELETE FROM activity_logs WHERE id = ANY($1)', [ids]);
        return res.redirectWithFlash('/admin/activity-logs', 'success', `Permanently deleted ${del.rowCount || 0} activity log(s).`);
    });

    app.delete('/admin/activity-logs/:id', ...adminGuard('admin.activity-logs.destroy'), async (req, res) => {
        await query('DELETE FROM activity_logs WHERE id = $1', [req.params.id]);
        return res.redirectWithFlash('/admin/activity-logs', 'success', 'Activity log deleted successfully.');
    });

    // 8. Community Concerns
    app.get('/admin/concerns', ...adminGuard('admin.concerns'), async (req, res) => {
        const currentStatus = String(req.query.status || 'All');
        const conditions = [];
        const params = [];

        if (currentStatus !== 'All') {
            params.push(currentStatus);
            conditions.push(`c.status = $${params.length}`);
        }
        if (req.query.search && String(req.query.search).trim() !== '') {
            params.push(`%${String(req.query.search).trim()}%`);
            const sp = `$${params.length}`;
            conditions.push(`(c.concern_id ILIKE ${sp} OR c.resident_name ILIKE ${sp} OR c.title ILIKE ${sp} OR c.category ILIKE ${sp} OR c.location ILIKE ${sp})`);
        }
        const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [concernsRes, countRows] = await Promise.all([
            query(
                `SELECT c.*, u.name AS u_name, ua.name AS updated_by_name
                 FROM community_concerns c
                 LEFT JOIN users u ON u.id = c.user_id
                 LEFT JOIN users ua ON ua.id = c.updated_by
                 ${whereSql}
                 ORDER BY c.created_at DESC`,
                params
            ),
            query('SELECT status, COUNT(*)::int AS cnt FROM community_concerns GROUP BY status'),
        ]);

        const concernIds = concernsRes.rows.map((c) => Number(c.id));
        const remarksMap = {};
        if (concernIds.length > 0) {
            const { rows: remRows } = await query(
                `SELECT r.*, a.name AS admin_name
                 FROM community_concern_remarks r
                 LEFT JOIN users a ON a.id = r.admin_id
                 WHERE r.community_concern_id = ANY($1)
                 ORDER BY r.created_at DESC`,
                [concernIds]
            );
            for (const rm of remRows) {
                const cid = Number(rm.community_concern_id);
                if (!remarksMap[cid]) remarksMap[cid] = [];
                remarksMap[cid].push({ ...rm, admin: rm.admin_name ? { id: Number(rm.admin_id), name: rm.admin_name } : null });
            }
        }

        const concerns = concernsRes.rows.map((c) => ({
            ...c,
            id: Number(c.id),
            user: c.u_name ? { id: Number(c.user_id), name: c.u_name } : null,
            updated_by_admin: c.updated_by_name ? { id: Number(c.updated_by), name: c.updated_by_name } : null,
            remarks: remarksMap[Number(c.id)] || [],
        }));

        const statusCounts = { All: 0, Pending: 0, 'Under Review': 0, 'In Progress': 0, Resolved: 0, Rejected: 0 };
        for (const r of countRows.rows) {
            statusCounts[r.status] = r.cnt;
            statusCounts.All += r.cnt;
        }

        return renderAdmin(res, 'admin/concerns/index', {
            concerns,
            currentStatus,
            statusCounts,
            concernStatuses: CONCERN_STATUSES,
        });
    });

    async function handleUpdateConcern(req, res) {
        const concern = await queryOne('SELECT * FROM community_concerns WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!concern) return res.status(404).send('Concern not found.');
        const status = req.body?.status;
        if (!CONCERN_STATUSES.includes(status)) {
            return res.redirectBackWithErrors({ status: 'Invalid concern status.' }, req.body, '/admin/concerns');
        }
        const remarks = req.body?.admin_remarks ? String(req.body.admin_remarks).slice(0, 5000) : null;

        let attachmentPath = null;
        if (req.file) {
            attachmentPath = await uploadBuffer(req.file.buffer, 'community-concern-feedback', req.file.originalname, req.file.mimetype);
        }

        let previousStatus = concern.status;
        try {
            await withTransaction(async (client) => {
                previousStatus = concern.status;
                await client.query(
                    `UPDATE community_concerns
                     SET status = $1, updated_by = $2, admin_remarks = COALESCE($3, admin_remarks), updated_at = NOW()
                     WHERE id = $4`,
                    [status, req.user.id, remarks || null, concern.id]
                );

                if (remarks || attachmentPath) {
                    await client.query(
                        `INSERT INTO community_concern_remarks (community_concern_id, admin_id, remark, attachment_path, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
                        [concern.id, req.user.id, remarks || '', attachmentPath]
                    );
                }
            });
        } catch (err) {
            if (attachmentPath) await deleteFile(attachmentPath, ['community-concern-feedback']);
            throw err;
        }

        const updatedConcern = { ...concern, status };
        await ActivityLog.record('concern_updated', `Updated community concern #${concern.concern_id} to ${status}.`, req.user.id, req);

        if (concern.user_id) {
            const msg = buildConcernNotificationMessage(updatedConcern, previousStatus, remarks);
            await NotificationService.notifyUser(concern.user_id, 'App\\Notifications\\ConcernStatusUpdatedNotification', {
                type: 'concern_update',
                concern_id: concern.concern_id,
                title: concern.title,
                status,
                message: msg,
                link: '/resident/community-concerns',
            });
        }

        return res.redirectWithFlash('/admin/concerns', 'success', 'Community concern updated successfully.');
    }

    app.patch('/admin/concerns/:id', ...adminGuard('admin.concerns.update'), uploadImage5MB.single('feedback_image'), verifyMultipartCsrfAndMethod, handleUpdateConcern);
    app.post('/admin/concerns/:id', ...adminGuard('admin.concerns.update'), uploadImage5MB.single('feedback_image'), verifyMultipartCsrfAndMethod, handleUpdateConcern);

    // 9. Document Types Catalog
    async function handleDocumentTypesIndex(req, res) {
        const conditions = [];
        const params = [];
        if (req.query.status === 'active') conditions.push('is_active = TRUE');
        else if (req.query.status === 'inactive') conditions.push('is_active = FALSE');
        if (req.query.search && String(req.query.search).trim() !== '') {
            params.push(`%${String(req.query.search).trim()}%`);
            const sp = `$${params.length}`;
            conditions.push(`(name ILIKE ${sp} OR description ILIKE ${sp})`);
        }
        const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const [rowsRes, statsRow, availableTemplates] = await Promise.all([
            query(`SELECT * FROM document_types ${whereSql} ORDER BY name ASC`, params),
            queryOne(`SELECT COUNT(*)::int AS total,
                             COUNT(*) FILTER (WHERE is_active)::int AS active,
                             COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive,
                             COUNT(*) FILTER (WHERE fee > 0)::int AS paid,
                             COUNT(*) FILTER (WHERE fee = 0)::int AS free
                      FROM document_types`),
            listAvailableTemplates(),
        ]);

        return renderAdmin(res, 'admin/document_types/index', {
            documentTypes: rowsRes.rows.map(hydrateDocumentType),
            stats: statsRow || { total: 0, active: 0, inactive: 0, paid: 0, free: 0 },
            availableTemplates,
        });
    }

    app.get('/admin/document-types', ...adminGuard('admin.document-types.index'), handleDocumentTypesIndex);
    app.get('/admin/document-management', ...adminGuard('admin.documents.index'), handleDocumentTypesIndex);
    app.get('/admin/documents', ...adminGuard('admin.document-types.index'), handleDocumentTypesIndex);

    app.post(
        '/admin/document-types',
        ...adminGuard('admin.document-types.store'),
        uploadDocx10MB.single('template_file'),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            const b = req.body || {};
            if (!b.name || b.fee === undefined || b.fee === '') {
                return res.redirectBackWithErrors({ name: 'Document name and fee are required.' }, b, '/admin/document-types');
            }
            const dup = await queryOne('SELECT id FROM document_types WHERE name = $1 LIMIT 1', [String(b.name).trim()]);
            if (dup) {
                return res.redirectBackWithErrors({ name: 'A document type with that name already exists.' }, b, '/admin/document-types');
            }

            const reqArray = parseCsvOrLines(b.requirements);
            let templateFileName = null;
            if (req.file) {
                const slug = String(b.name || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                const ext = path.extname(req.file.originalname || '.docx').toLowerCase() || '.docx';
                const cleanName = `template_${slug}_${Math.floor(Date.now() / 1000)}${ext}`;
                templateFileName = await putBuffer(`document_templates/${cleanName}`, req.file.buffer, req.file.mimetype);
            } else if (b.existing_template) {
                templateFileName = resolveExistingTemplateSelection(b.existing_template);
            }

            const isActive = b.is_active !== undefined ? (b.is_active === '1' || b.is_active === 'true' || b.is_active === 'on') : true;
            const created = await queryOne(
                `INSERT INTO document_types (name, fee, processing_days, description, requirements, template_file, is_active, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW(), NOW()) RETURNING *`,
                [
                    String(b.name).trim(),
                    Number(b.fee) || 0,
                    b.processing_days || '1-2 Business Days',
                    b.description || null,
                    JSON.stringify(reqArray),
                    templateFileName,
                    isActive,
                ]
            );

            await ActivityLog.record('document_type_created', `Created new document type: ${created.name} with fee ₱${Number(created.fee).toFixed(2)}.`, req.user.id, req);
            return res.redirectWithFlash('/admin/document-types', 'success', `Document type '${created.name}' added successfully${templateFileName ? ' with custom Word template.' : '.'}`);
        }
    );

    async function handleUpdateDocumentType(req, res) {
        const docType = await queryOne('SELECT * FROM document_types WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!docType) return res.status(404).send('Document type not found.');
        const b = req.body || {};
        if (!b.name || b.fee === undefined || b.fee === '') {
            return res.redirectBackWithErrors({ name: 'Document name and fee are required.' }, b, '/admin/document-types');
        }
        const dup = await queryOne('SELECT id FROM document_types WHERE name = $1 AND id != $2 LIMIT 1', [String(b.name).trim(), docType.id]);
        if (dup) {
            return res.redirectBackWithErrors({ name: 'Another document type with that name already exists.' }, b, '/admin/document-types');
        }

        const reqArray = parseCsvOrLines(b.requirements);
        let templateFile = docType.template_file;

        if (req.file) {
            if (docType.template_file && String(docType.template_file).startsWith('document_templates/template_')) {
                await deleteFile(docType.template_file, ['document_templates']);
            }
            const slug = String(b.name || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const ext = path.extname(req.file.originalname || '.docx').toLowerCase() || '.docx';
            const cleanName = `template_${slug}_${Math.floor(Date.now() / 1000)}${ext}`;
            templateFile = await putBuffer(`document_templates/${cleanName}`, req.file.buffer, req.file.mimetype);
        } else if (b.existing_template) {
            templateFile = resolveExistingTemplateSelection(b.existing_template);
        } else if (b.remove_template === '1' || b.remove_template === 'true') {
            if (docType.template_file && String(docType.template_file).startsWith('document_templates/template_')) {
                await deleteFile(docType.template_file, ['document_templates']);
            }
            templateFile = null;
        }

        const isActive = b.is_active !== undefined ? (b.is_active === '1' || b.is_active === 'true' || b.is_active === 'on') : docType.is_active;

        await query(
            `UPDATE document_types SET
                name = $1, fee = $2, processing_days = $3, description = $4,
                requirements = $5::jsonb, template_file = $6, is_active = $7, updated_at = NOW()
             WHERE id = $8`,
            [
                String(b.name).trim(),
                Number(b.fee) || 0,
                b.processing_days || '1-2 Business Days',
                b.description || null,
                JSON.stringify(reqArray),
                templateFile,
                isActive,
                docType.id,
            ]
        );

        await ActivityLog.record('document_type_updated', `Updated document type: ${b.name}.`, req.user.id, req);
        return res.redirectWithFlash('/admin/document-types', 'success', `Document type '${b.name}' updated successfully.`);
    }

    app.patch('/admin/document-types/:id', ...adminGuard('admin.document-types.update'), uploadDocx10MB.single('template_file'), verifyMultipartCsrfAndMethod, handleUpdateDocumentType);
    app.post('/admin/document-types/:id', ...adminGuard('admin.document-types.update'), uploadDocx10MB.single('template_file'), verifyMultipartCsrfAndMethod, handleUpdateDocumentType);

    app.get('/admin/document-types/:id/template', ...adminGuard('admin.document-types.download-template'), async (req, res) => {
        const docType = await queryOne('SELECT * FROM document_types WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!docType || !docType.template_file) {
            return res.redirectWithFlash('/admin/document-types', 'error', 'This document type does not have a custom template.');
        }
        const found = await readFileBuffer(docType.template_file, ['document_templates']);
        if (!found?.buffer) {
            return res.redirectWithFlash('/admin/document-types', 'error', 'Template file not found on disk.');
        }
        res.setHeader('Content-Type', found.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${found.filename}"`);
        return res.send(found.buffer);
    });

    app.patch('/admin/document-types/:id/toggle-status', ...adminGuard('admin.document-types.toggle-status'), async (req, res) => {
        const docType = await queryOne('SELECT * FROM document_types WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!docType) return res.status(404).send('Not found.');
        const nextActive = !docType.is_active;
        await query('UPDATE document_types SET is_active = $1, updated_at = NOW() WHERE id = $2', [nextActive, docType.id]);
        const statusText = nextActive ? 'activated' : 'deactivated';
        await ActivityLog.record('document_type_status_toggled', `Document type '${docType.name}' has been ${statusText}.`, req.user.id, req);
        return res.redirectWithFlash('/admin/document-types', 'success', `Document type '${docType.name}' has been ${statusText}.`);
    });

    app.delete('/admin/document-types/bulk-delete', ...adminGuard('admin.document-types.bulk-delete'), async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        if (ids.length === 0) return res.redirectBackWithErrors({ ids: 'Select document types to delete.' }, false, '/admin/document-types');
        const del = await query('DELETE FROM document_types WHERE id = ANY($1)', [ids]);
        await ActivityLog.record('document_types_bulk_deleted', `Permanently deleted ${del.rowCount || 0} document type(s).`, req.user.id, req);
        return res.redirectWithFlash('/admin/document-types', 'success', `Permanently deleted ${del.rowCount || 0} document type(s).`);
    });

    app.delete('/admin/document-types/:id', ...adminGuard('admin.document-types.destroy'), async (req, res) => {
        const docType = await queryOne('SELECT * FROM document_types WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!docType) return res.status(404).send('Not found.');
        await query('DELETE FROM document_types WHERE id = $1', [docType.id]);
        await ActivityLog.record('document_type_deleted', `Permanently deleted document type: ${docType.name}.`, req.user.id, req);
        return res.redirectWithFlash('/admin/document-types', 'success', `Document type '${docType.name}' has been permanently deleted.`);
    });

    // 10. Admin Settings
    app.get('/admin/settings', ...adminGuard('admin.settings'), async (req, res) => {
        const settings = await BarangaySetting.allAssoc();
        return renderAdmin(res, 'admin/settings', { user: req.user, settings });
    });

    app.post(
        '/admin/settings/profile',
        ...adminGuard('admin.settings.profile'),
        uploadImage2MB.single('profile_picture'),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            const b = req.body || {};
            if (!b.name || !b.email) {
                return res.redirectBackWithErrors({ name: 'Name and email are required.' }, b, '/admin/settings');
            }
            let profilePic = req.user.profile_picture;
            if (b.remove_profile_picture === '1') {
                if (profilePic) await deleteFile(profilePic, ['profile_pictures']);
                profilePic = null;
            } else if (req.file) {
                if (profilePic) await deleteFile(profilePic, ['profile_pictures']);
                profilePic = await uploadBuffer(req.file.buffer, 'profile_pictures', req.file.originalname, req.file.mimetype);
            }
            await query('UPDATE users SET name = $1, email = $2, profile_picture = $3, updated_at = NOW() WHERE id = $4', [
                b.name,
                b.email,
                profilePic,
                req.user.id,
            ]);
            await ActivityLog.record('profile_updated', 'Admin updated their profile information.', req.user.id, req);
            req.flash('active_tab', 'profile-tab');
            return res.redirectWithFlash('/admin/settings', 'success', 'Profile information updated successfully!');
        }
    );

    app.post('/admin/settings/password', ...adminGuard('admin.settings.password'), async (req, res) => {
        const b = req.body || {};
        if (!b.current_password || !b.new_password || String(b.new_password).length < 8 || b.new_password !== b.new_password_confirmation) {
            req.flash('active_tab', 'password-tab');
            return res.redirectBackWithErrors({ new_password: 'New password must be at least 8 characters and match confirmation.' }, false, '/admin/settings');
        }
        if (!(await verifySecret(String(b.current_password), req.user.password))) {
            req.flash('active_tab', 'password-tab');
            return res.redirectBackWithErrors({ current_password: 'The current password you entered is incorrect.' }, false, '/admin/settings');
        }
        const hashed = await hashSecret(b.new_password);
        await query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, req.user.id]);
        await ActivityLog.record('password_changed', 'Admin changed their account password.', req.user.id, req);
        req.flash('active_tab', 'password-tab');
        return res.redirectWithFlash('/admin/settings', 'password_success', 'Password changed successfully!');
    });

    app.post(
        '/admin/settings/barangay',
        ...adminGuard('admin.settings.barangay'),
        uploadAnySettings.fields([
            { name: 'barangay_logo', maxCount: 1 },
            { name: 'municipal_logo', maxCount: 1 },
            { name: 'gcash_qr_code', maxCount: 1 },
        ]),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            const b = req.body || {};
            const files = req.files || {};
            const group = String(b._group || 'general');

            if (group === 'barangay') {
                const fields = [
                    'barangay_name', 'municipality', 'province', 'region', 'barangay_tagline',
                    'barangay_captain', 'barangay_secretary', 'barangay_treasurer',
                    'barangay_hall_address', 'official_contact', 'emergency_hotline',
                    'official_email', 'office_hours',
                ];
                for (const f of fields) {
                    if (Object.prototype.hasOwnProperty.call(b, f)) {
                        await BarangaySetting.set(f, b[f], 'barangay');
                    }
                }
                if (files.barangay_logo?.[0]) {
                    await deleteFile(await BarangaySetting.get('barangay_logo'), ['settings']);
                    const p = await uploadBuffer(files.barangay_logo[0].buffer, 'settings', files.barangay_logo[0].originalname, files.barangay_logo[0].mimetype);
                    await BarangaySetting.set('barangay_logo', p, 'barangay');
                }
                if (files.municipal_logo?.[0]) {
                    await deleteFile(await BarangaySetting.get('municipal_logo'), ['settings']);
                    const p = await uploadBuffer(files.municipal_logo[0].buffer, 'settings', files.municipal_logo[0].originalname, files.municipal_logo[0].mimetype);
                    await BarangaySetting.set('municipal_logo', p, 'barangay');
                }
                await ActivityLog.record('settings_updated', 'Admin updated Barangay Information and Officials.', req.user.id, req);
                req.flash('active_tab', 'barangay-tab');
                return res.redirectWithFlash('/admin/settings', 'success', 'Barangay Information and Officials updated successfully!');
            }

            if (group === 'payment') {
                await BarangaySetting.set('payment_gcash_enabled', b.payment_gcash_enabled ? '1' : '0', 'payment');
                await BarangaySetting.set('gcash_account_name', b.gcash_account_name || '', 'payment');
                await BarangaySetting.set('gcash_account_number', b.gcash_account_number || '', 'payment');
                await BarangaySetting.set('payment_maya_enabled', b.payment_maya_enabled ? '1' : '0', 'payment');
                await BarangaySetting.set('maya_account_name', b.maya_account_name || '', 'payment');
                await BarangaySetting.set('maya_account_number', b.maya_account_number || '', 'payment');
                await BarangaySetting.set('payment_instructions', b.payment_instructions || '', 'payment');
                if (files.gcash_qr_code?.[0]) {
                    await deleteFile(await BarangaySetting.get('gcash_qr_code'), ['settings']);
                    const p = await uploadBuffer(files.gcash_qr_code[0].buffer, 'settings', files.gcash_qr_code[0].originalname, files.gcash_qr_code[0].mimetype);
                    await BarangaySetting.set('gcash_qr_code', p, 'payment');
                }
                await ActivityLog.record('settings_updated', 'Admin updated Payment and GCash/Maya settings.', req.user.id, req);
                req.flash('active_tab', 'payment-tab');
                return res.redirectWithFlash('/admin/settings', 'success', 'Payment and QR settings updated successfully!');
            }

            if (group === 'documents') {
                await BarangaySetting.set('default_processing_days', b.default_processing_days || '2', 'documents');
                await BarangaySetting.set('tracking_prefix', String(b.tracking_prefix || 'REQ').trim().toUpperCase(), 'documents');
                await BarangaySetting.set('online_requests_enabled', b.online_requests_enabled ? '1' : '0', 'documents');
                await BarangaySetting.set('max_active_requests_per_resident', b.max_active_requests_per_resident || '3', 'documents');
                await ActivityLog.record('settings_updated', 'Admin updated Document Request policies.', req.user.id, req);
                req.flash('active_tab', 'documents-tab');
                return res.redirectWithFlash('/admin/settings', 'success', 'Document processing policies updated successfully!');
            }

            if (group === 'residents') {
                await BarangaySetting.set('resident_verification_mode', b.resident_verification_mode || 'manual', 'residents');
                await BarangaySetting.set('minimum_registration_age', b.minimum_registration_age || '15', 'residents');
                await BarangaySetting.set('purok_list', b.purok_list || '', 'residents');
                await BarangaySetting.set('accepted_ids', b.accepted_ids || '', 'residents');
                await ActivityLog.record('settings_updated', 'Admin updated Resident registration and verification rules.', req.user.id, req);
                req.flash('active_tab', 'residents-tab');
                return res.redirectWithFlash('/admin/settings', 'success', 'Resident registration rules updated successfully!');
            }

            if (group === 'announcements') {
                if (!isSafeActionUrl(b.announcement_action_url)) {
                    req.flash('active_tab', 'announcements-tab');
                    return res.redirectBackWithErrors({ announcement_action_url: 'The action URL must start with http://, https://, or a relative / path.' }, b, '/admin/settings');
                }
                await BarangaySetting.set('announcement_enabled', b.announcement_enabled ? '1' : '0', 'announcements');
                await BarangaySetting.set('announcement_type', b.announcement_type || 'info', 'announcements');
                await BarangaySetting.set('announcement_category', b.announcement_category || 'General Advisory', 'announcements');
                await BarangaySetting.set('announcement_title', b.announcement_title || '', 'announcements');
                await BarangaySetting.set('announcement_message', b.announcement_message || '', 'announcements');
                await BarangaySetting.set('announcement_action_url', b.announcement_action_url || '', 'announcements');
                await BarangaySetting.set('announcement_action_text', b.announcement_action_text || '', 'announcements');
                await BarangaySetting.set('announcement_is_dismissible', b.announcement_is_dismissible ? '1' : '0', 'announcements');
                await BarangaySetting.set('announcement_expiry_date', b.announcement_expiry_date || '', 'announcements');
                await ActivityLog.record('settings_updated', 'Admin updated Portal Announcement banner.', req.user.id, req);
                req.flash('active_tab', 'announcements-tab');
                return res.redirectWithFlash('/admin/settings', 'success', 'Portal Announcement updated successfully!');
            }

            if (group === 'system') {
                await BarangaySetting.set('system_maintenance_mode', b.system_maintenance_mode ? '1' : '0', 'system');
                await BarangaySetting.set('session_timeout_minutes', b.session_timeout_minutes || '120', 'system');
                await ActivityLog.record('settings_updated', 'Admin updated System and Maintenance configuration.', req.user.id, req);
                req.flash('active_tab', 'system-tab');
                return res.redirectWithFlash('/admin/settings', 'success', 'System configuration updated successfully!');
            }

            return res.redirect('/admin/settings');
        }
    );

    app.get('/admin/settings/backup-db', ...adminGuard('admin.settings.backup-db'), async (req, res) => {
        const sql = await generatePostgresBackupSql(req.user);
        await ActivityLog.record('backup_downloaded', 'Admin downloaded a database backup (.sql).', req.user.id, req);
        const filename = `ebarangay_backup_${new Date().toISOString().replace(/[:T]/g, '_').slice(0, 19)}.sql`;
        res.setHeader('Content-Type', 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(sql);
    });

    // 11. Admin Notifications (AJAX)
    app.get('/admin/notifications', ...adminGuard('admin.notifications.get'), async (req, res) => {
        const { unreadCount, notifications } = await NotificationService.getUserNotifications(req.user.id, 10);
        return res.json({
            unread_count: unreadCount,
            notifications: notifications.map((n) => ({
                id: n.id,
                message: n.data?.message || '',
                link: n.data?.link || '#',
                type: n.data?.type || 'info',
                read: Boolean(n.read_at),
                created_at: diffForHumans(n.created_at),
            })),
        });
    });

    app.post('/admin/notifications/mark-read', ...adminGuard('admin.notifications.read'), async (req, res) => {
        if (req.body?.notification_id) {
            await NotificationService.markOneRead(req.user.id, req.body.notification_id);
        } else {
            await NotificationService.markAllRead(req.user.id);
        }
        return res.json({ success: true });
    });
}
