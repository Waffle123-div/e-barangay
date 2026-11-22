import crypto from 'crypto';
import { query, queryOne } from '../db/pool.js';
import {
    ActivityLog,
    BarangaySetting,
    hydrateDocumentRequest,
    hydrateDocumentType,
    RESIDENT_CONCERN_CATEGORIES,
} from '../lib/models.js';
import { verifySecret } from '../lib/password.js';
import { diffForHumans } from '../lib/viewHelpers.js';
import { requireAuth, requireResidentPin, requireVerified } from '../middleware/auth.js';
import { verifyMultipartCsrfAndMethod } from '../middleware/csrf.js';
import { populateResidentLayoutLocals } from '../middleware/layoutLocals.js';
import { limit10PerMin } from '../middleware/rateLimit.js';
import { uploadImage5MB, uploadImageOrPdf10MB } from '../middleware/upload.js';
import { broadcastRealtimeEvent } from '../services/realtimeService.js';
import { serveFile, uploadBuffer } from '../services/storageService.js';

function residentGuard(routeName) {
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

function ensureActiveResident(req, res) {
    if (String(req.user?.status || '').trim().toLowerCase() !== 'active') {
        res.redirect('/resident/pending-approval');
        return false;
    }
    return true;
}

function renderResident(res, view, locals = {}) {
    return res.render(view, locals, (err, html) => {
        if (err) throw err;
        return res.render('resident/layouts/resident', { ...locals, body: html });
    });
}

async function generateUniqueTrackingNumber() {
    const year = new Date().getFullYear();
    for (let i = 0; i < 15; i++) {
        const rand = String(crypto.randomInt(1, 100000)).padStart(5, '0');
        const trk = `REQ-${year}-${rand}`;
        const existing = await queryOne('SELECT id FROM document_requests WHERE tracking_number = $1 LIMIT 1', [trk]);
        if (!existing) return trk;
    }
    return `REQ-${year}-${Date.now().toString().slice(-5)}`;
}

export function registerResidentPortalRoutes(app) {
    // Dashboard
    app.get('/resident', ...residentGuard('resident.dashboard'), async (req, res) => {
        if (!ensureActiveResident(req, res)) return;
        const user = req.user;

        const [pendingRow, approvedRow, totalRow, recentRes, settingsMap, msgRec] = await Promise.all([
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE user_id = $1 AND status = 'Pending'", [user.id]),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE user_id = $1 AND status = 'Approved'", [user.id]),
            queryOne('SELECT COUNT(*)::int AS cnt FROM document_requests WHERE user_id = $1', [user.id]),
            query('SELECT * FROM document_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [user.id]),
            BarangaySetting.allAssoc(),
            BarangaySetting.getRecord('announcement_message'),
        ]);

        let announcement = null;
        if (String(settingsMap.announcement_enabled || '0') === '1') {
            const expiry = settingsMap.announcement_expiry_date;
            let notExpired = true;
            if (expiry) {
                const expDate = new Date(`${expiry}T23:59:59`);
                notExpired = expDate.getTime() > Date.now();
            }
            if (notExpired) {
                announcement = {
                    type: settingsMap.announcement_type || 'info',
                    category: settingsMap.announcement_category || 'General Advisory',
                    title: settingsMap.announcement_title || 'Public Advisory',
                    message: settingsMap.announcement_message || '',
                    action_url: settingsMap.announcement_action_url || null,
                    action_text: settingsMap.announcement_action_text || 'Learn More',
                    is_dismissible: String(settingsMap.announcement_is_dismissible ?? '1') === '1',
                    updated_at: msgRec?.updated_at || null,
                };
            }
        }

        const totalCount = totalRow?.cnt || 0;
        const firstName = String(user.name || '').trim().split(/\s+/)[0] || 'Resident';

        return renderResident(res, 'resident/dashboardresident', {
            pendingCount: pendingRow?.cnt || 0,
            approvedCount: approvedRow?.cnt || 0,
            totalCount,
            recentRequests: recentRes.rows.map((r) => hydrateDocumentRequest(r)),
            firstName,
            isNewUser: totalCount === 0,
            announcement,
        });
    });

    // Request Document Form
    app.get('/resident/request-document', ...residentGuard('resident.request.create'), async (req, res) => {
        if (!ensureActiveResident(req, res)) return;

        const [latestRow, docTypesRes] = await Promise.all([
            queryOne('SELECT * FROM document_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [req.user.id]),
            query('SELECT * FROM document_types WHERE is_active = TRUE ORDER BY name ASC'),
        ]);

        const statusStepMap = {
            Pending: 1,
            'Under Review': 2,
            Processing: 3,
            Ready: 4,
            Completed: 5,
            Rejected: 0,
        };
        const latestRequest = hydrateDocumentRequest(latestRow);
        const currentStep = latestRequest ? (statusStepMap[latestRequest.status] ?? 1) : 0;
        const activeDocTypes = docTypesRes.rows.map(hydrateDocumentType);

        return renderResident(res, 'resident/request_document', {
            latestRequest,
            currentStep,
            activeDocTypes,
            docTypesList: activeDocTypes,
        });
    });

    // Store Document Request
    app.post(
        '/resident/request-document',
        ...residentGuard('resident.request.store'),
        uploadImageOrPdf10MB.array('attachments', 10),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            if (!ensureActiveResident(req, res)) return;
            const user = req.user;
            const b = req.body || {};

            const trackingNumber = await generateUniqueTrackingNumber();

            let firstName = b.first_name || '';
            let lastName = b.last_name || '';
            let middleInitial = b.middle_initial || '';

            if ((!firstName || !lastName) && b.full_name && String(b.full_name).trim()) {
                const parts = String(b.full_name).trim().split(/\s+/);
                if (parts.length === 1) {
                    firstName = parts[0];
                    lastName = parts[0];
                    middleInitial = '';
                } else if (parts.length === 2) {
                    firstName = parts[0];
                    lastName = parts[1];
                    middleInitial = '';
                } else {
                    firstName = parts[0];
                    const second = parts[1].replace(/\./g, '').trim();
                    if (second.length <= 2) {
                        middleInitial = second;
                        lastName = parts.slice(2).join(' ');
                    } else {
                        middleInitial = parts[1].slice(0, 1);
                        lastName = parts.slice(2).join(' ');
                    }
                }
            }

            firstName = String(firstName || user.first_name || '').toUpperCase();
            middleInitial = String(middleInitial || (user.middle_name ? user.middle_name.slice(0, 1) : '')).toUpperCase();
            lastName = String(lastName || user.last_name || '').toUpperCase();
            const age = b.age || user.age || null;
            const contactNumber = b.contact_number || user.phone_number || null;
            const inputEmail = b.email || user.email || null;
            const residentEmail = inputEmail ? String(inputEmail).toLowerCase() : null;

            let purok = b.purok || '';
            let street = b.street || '';
            if (!purok && b.address && String(b.address).trim()) {
                const addr = String(b.address).trim();
                street = addr;
                const match = addr.match(/purok\s*[\w\d]+/i);
                purok = match ? match[0] : (user.purok || '');
            }
            purok = String(purok || user.purok || '').toUpperCase();
            street = String(street || user.sitio || user.street || '').toUpperCase();
            const city = String(b.city || 'COGON EAST, CARMEN, CEBU').toUpperCase();

            let docType = b.document_type || '';
            let purpose = String(b.purpose || '').trim().toUpperCase();

            if (!docType && b.documents_json) {
                try {
                    const decoded = JSON.parse(b.documents_json);
                    if (Array.isArray(decoded) && decoded.length > 0) {
                        docType = decoded[0]?.type || '';
                        if (!purpose && decoded[0]?.purpose) {
                            purpose = String(decoded[0].purpose).trim().toUpperCase();
                        }
                    }
                } catch (_) {}
            } else if (!docType && Array.isArray(b.documents) && b.documents.length > 0) {
                const firstDoc = b.documents[0];
                docType = typeof firstDoc === 'object' ? (firstDoc?.type || '') : String(firstDoc || '');
                if (!purpose && typeof firstDoc === 'object' && firstDoc?.purpose) {
                    purpose = String(firstDoc.purpose).trim().toUpperCase();
                }
            }

            const docTypeRecord = docType ? await queryOne('SELECT * FROM document_types WHERE name = $1 LIMIT 1', [docType]) : null;
            const fee = docTypeRecord?.fee !== null && docTypeRecord?.fee !== undefined ? Number(docTypeRecord.fee) : null;
            const documentsJson = [{ type: docType, purpose, fee, is_generated: false }];
            const priority = b.urgency === 'Urgent' ? 'Urgent' : 'Normal';
            const selectedIdType = b.id_type || user.id_type || null;

            if (b.id_type && !user.id_type) {
                await query('UPDATE users SET id_type = $1, updated_at = NOW() WHERE id = $2', [b.id_type, user.id]);
            }

            let metaList = [];
            if (b.attachment_meta) {
                try {
                    const parsed = JSON.parse(b.attachment_meta);
                    if (Array.isArray(parsed)) metaList = parsed;
                } catch (_) {}
            }

            const attachmentsData = [];
            const uploadedFiles = req.files || [];
            for (let idx = 0; idx < uploadedFiles.length; idx++) {
                const file = uploadedFiles[idx];
                const filePath = await uploadBuffer(file.buffer, 'attachments', file.originalname, file.mimetype);
                const matchedMeta = metaList.find((m) => m && m.name === file.originalname) || metaList[idx] || {};
                const ext = (file.originalname.split('.').pop() || '').toLowerCase();
                const fileType = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) ? 'image' : 'document';
                attachmentsData.push({
                    file_path: filePath,
                    file_name: file.originalname,
                    doc_type: matchedMeta.doc_type || 'Supporting Document',
                    file_type: fileType,
                    file_size: file.size,
                });
            }

            const inserted = await queryOne(
                `INSERT INTO document_requests (
                    user_id, tracking_number, first_name, middle_initial, last_name,
                    age, contact_number, resident_email, purok, street, city,
                    document_type_id, document_type, id_type, documents, attachments,
                    priority, purpose, fee, status, is_generated, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10, $11,
                    $12, $13, $14, $15::jsonb, $16::jsonb,
                    $17, $18, $19, 'Pending', FALSE, NOW(), NOW()
                ) RETURNING *`,
                [
                    user.id, trackingNumber, firstName, middleInitial, lastName,
                    age, contactNumber, residentEmail, purok, street, city,
                    docTypeRecord?.id || null, docType, selectedIdType,
                    JSON.stringify(documentsJson),
                    attachmentsData.length > 0 ? JSON.stringify(attachmentsData) : null,
                    priority, purpose, fee,
                ]
            );

            await ActivityLog.record('Document Request', `Requested: ${inserted.document_type}`, user.id, req);

            await broadcastRealtimeEvent('request.created', {
                id: Number(inserted.id),
                tracking_number: inserted.tracking_number,
                status: inserted.status,
                applicant: `${inserted.first_name} ${inserted.last_name}`,
                document_type: inserted.document_type,
                message: `New Request #${inserted.tracking_number} (${inserted.document_type}) submitted by ${inserted.first_name} ${inserted.last_name}.`,
            });

            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.json({
                    success: true,
                    message: 'Document request submitted successfully!',
                    redirect: '/resident/track-request',
                });
            }
            return res.redirectWithFlash('/resident/track-request', 'success', 'Document request submitted successfully!');
        }
    );

    // Track Requests
    app.get('/resident/track-request', ...residentGuard('resident.request.track'), async (req, res) => {
        if (!ensureActiveResident(req, res)) return;
        const { rows } = await query('SELECT * FROM document_requests WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        const allRequests = rows.map((r) => hydrateDocumentRequest(r));
        const myRequest = allRequests[0] || null;
        let currentLastUpdate = '';
        for (const r of rows) {
            if (r.updated_at && (!currentLastUpdate || new Date(r.updated_at) > new Date(currentLastUpdate))) {
                currentLastUpdate = new Date(r.updated_at).toISOString();
            }
        }
        return renderResident(res, 'resident/track_request', {
            myRequest,
            allRequests,
            currentLastUpdate,
            currentTotalCount: allRequests.length,
        });
    });

    // Polling check-updates
    app.get('/resident/requests/check-updates', ...residentGuard('resident.requests.check'), async (req, res) => {
        const [latest, totalRow, activeRow] = await Promise.all([
            queryOne('SELECT id, status, tracking_number, updated_at FROM document_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [req.user.id]),
            queryOne('SELECT COUNT(*)::int AS cnt FROM document_requests WHERE user_id = $1', [req.user.id]),
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE user_id = $1 AND status NOT IN ('Completed', 'Rejected', 'Cancelled')", [req.user.id]),
        ]);
        return res.json({
            last_update: latest?.updated_at || null,
            latest_status: latest?.status || null,
            tracking_number: latest?.tracking_number || null,
            active_count: activeRow?.cnt || 0,
            total_count: totalRow?.cnt || 0,
        });
    });

    // Session Lock / Unlock
    app.post('/resident/session/lock', requireAuth('/resident/login'), requireVerified, (req, res) => {
        req.session.is_locked = true;
        return res.json({ success: true });
    });

    app.post('/resident/session/unlock', requireAuth('/resident/login'), requireVerified, limit10PerMin, async (req, res) => {
        const pin = String(req.body?.security_pin || '');
        if (!/^\d{6}$/.test(pin)) {
            return res.redirectBackWithErrors({ security_pin: 'Please enter a valid 6-digit PIN.' }, false, '/resident');
        }
        if (await verifySecret(pin, req.user.security_pin)) {
            delete req.session.is_locked;
            return res.redirectWithFlash('/resident', 'success', 'Session unlocked.');
        }
        req.session.is_locked = true;
        return res.redirectBackWithErrors({ security_pin: 'Incorrect PIN. Please try again.' }, false, '/resident');
    });

    // Notifications AJAX
    app.get('/resident/notifications', ...residentGuard('resident.notifications.get'), async (req, res) => {
        const { unreadCount, notifications } = await res.locals.userNotifs
            ? { unreadCount: res.locals.unreadNotifCount, notifications: res.locals.userNotifs }
            : { unreadCount: 0, notifications: [] };

        const mapped = notifications.map((n) => {
            const d = n.data || {};
            return {
                id: n.id,
                document_type: d.document_type || d.title || 'Document Update',
                status: d.status || '',
                tracking_number: d.tracking_number || d.concern_id || 'N/A',
                message: d.message || 'The status of your document has been updated.',
                link: d.link || '/resident/track-request',
                read: Boolean(n.read_at),
                created_at: diffForHumans(n.created_at),
            };
        });

        return res.json({ unread_count: unreadCount, notifications: mapped });
    });

    app.post('/resident/notifications/mark-read', ...residentGuard('resident.notifications.read'), async (req, res) => {
        await query('UPDATE notifications SET read_at = NOW(), updated_at = NOW() WHERE notifiable_id = $1 AND read_at IS NULL', [req.user.id]);
        return res.json({ success: true });
    });

    // Activity Logs
    app.get('/resident/activity-logs', ...residentGuard('resident.activity-logs'), async (req, res) => {
        if (!ensureActiveResident(req, res)) return;

        const page = Math.max(1, Number(req.query.page || 1));
        const perPage = 10;
        const offset = (page - 1) * perPage;

        const actionFilter = req.query.action ? String(req.query.action) : '';
        const searchFilter = req.query.search ? String(req.query.search).trim() : '';

        const params = [req.user.id];
        let where = 'WHERE user_id = $1';
        if (actionFilter) {
            params.push(actionFilter);
            where += ` AND action = $${params.length}`;
        }
        if (searchFilter) {
            params.push(`%${searchFilter}%`);
            where += ` AND (action ILIKE $${params.length} OR description ILIKE $${params.length})`;
        }

        const [actionRows, countRow, logRows] = await Promise.all([
            query('SELECT DISTINCT action FROM activity_logs WHERE user_id = $1 ORDER BY action ASC', [req.user.id]),
            queryOne(`SELECT COUNT(*)::int AS cnt FROM activity_logs ${where}`, params),
            query(`SELECT * FROM activity_logs ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, perPage, offset]),
        ]);

        // Pre-resolve tracking numbers to receipt IDs so EJS views need zero DB queries
        const trkNums = [];
        for (const l of logRows.rows) {
            const m = String(l.description || '').match(/#(REQ-[\w-]+)/);
            if (m) trkNums.push(m[1]);
        }
        const trkMap = {};
        if (trkNums.length > 0) {
            const { rows: docRows } = await query('SELECT id, tracking_number FROM document_requests WHERE tracking_number = ANY($1)', [trkNums]);
            for (const d of docRows) trkMap[d.tracking_number] = Number(d.id);
        }

        const logsData = logRows.rows.map((l) => {
            const m = String(l.description || '').match(/#(REQ-[\w-]+)/);
            return { ...l, linked_request_id: m ? (trkMap[m[1]] || null) : null };
        });

        const total = countRow?.cnt || 0;
        const paginator = {
            currentPage: page,
            lastPage: Math.max(1, Math.ceil(total / perPage)),
            total,
            firstItem: total === 0 ? 0 : offset + 1,
            lastItem: Math.min(offset + perPage, total),
            baseUrl: '/resident/activity-logs',
            query: req.query,
        };

        return renderResident(res, 'resident/activity_logs', {
            logs: logsData,
            paginator,
            actionTypes: actionRows.rows.map((r) => r.action),
        });
    });

    // Receipt handlers
    async function handleReceiptView(req, res) {
        if (!ensureActiveResident(req, res)) return;
        const docRow = await queryOne('SELECT * FROM document_requests WHERE id = $1 LIMIT 1', [req.params.id]);
        if (!docRow) return res.status(404).send('Receipt not found.');
        if (String(docRow.user_id) !== String(req.user.id)) {
            return res.status(403).send('Unauthorized access to this receipt.');
        }
        const docRequest = hydrateDocumentRequest(docRow);
        const receiptNumber = String(docRequest.tracking_number || '').replace('REQ', 'REC');
        const feeAmount = docRequest.fee !== null && docRequest.fee > 0 ? docRequest.fee : 0;
        return renderResident(res, 'resident/receipt', { docRequest, receiptNumber, feeAmount });
    }

    app.get('/resident/receipt/:id', ...residentGuard('resident.receipt.view'), handleReceiptView);
    app.get('/resident/receipt/:id/download', ...residentGuard('resident.receipt.download'), handleReceiptView);
    app.get('/receipt/:id', ...residentGuard('receipt.view'), handleReceiptView);
    app.get('/receipt/:id/download', ...residentGuard('receipt.download'), handleReceiptView);

    // Community Concerns
    app.get('/resident/community-concerns', ...residentGuard('resident.concerns'), async (req, res) => {
        if (!ensureActiveResident(req, res)) return;
        const user = req.user;
        const residentAddress = `${user.house_number || ''} ${user.street || ''}, ${user.barangay_address || ''}`.replace(/^[,\s]+|[,\s]+$/g, '').trim();

        const { rows: concernRows } = await query('SELECT * FROM community_concerns WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
        const concernIds = concernRows.map((c) => Number(c.id));

        const remarksByConcern = {};
        if (concernIds.length > 0) {
            const { rows: remarkRows } = await query(
                `SELECT r.*, u.name AS admin_name
                 FROM community_concern_remarks r
                 LEFT JOIN users u ON u.id = r.admin_id
                 WHERE r.community_concern_id = ANY($1)
                 ORDER BY r.created_at DESC`,
                [concernIds]
            );
            for (const rm of remarkRows) {
                const cid = Number(rm.community_concern_id);
                if (!remarksByConcern[cid]) remarksByConcern[cid] = [];
                remarksByConcern[cid].push({
                    ...rm,
                    admin: rm.admin_name ? { id: Number(rm.admin_id), name: rm.admin_name } : null,
                });
            }
        }

        const concerns = concernRows.map((c) => ({ ...c, id: Number(c.id), remarks: remarksByConcern[Number(c.id)] || [] }));
        return renderResident(res, 'resident/community_concerns', {
            concerns,
            categories: RESIDENT_CONCERN_CATEGORIES,
            residentAddress,
        });
    });

    app.post(
        '/resident/community-concerns',
        ...residentGuard('resident.concern.store'),
        uploadImage5MB.single('photo'),
        verifyMultipartCsrfAndMethod,
        async (req, res) => {
            if (!ensureActiveResident(req, res)) return;
            const b = req.body || {};
            if (!b.category || !b.description) {
                return res.redirectBackWithErrors({ category: 'Category and description are required.' }, b, '/resident/community-concerns');
            }

            const user = req.user;
            const concernId = `CON-${new Date().getFullYear()}-${String(crypto.randomInt(1, 100000)).padStart(5, '0')}`;
            const address = `${user.house_number || ''} ${user.street || ''}, ${user.barangay_address || ''}`.trim();
            let photoPath = null;
            if (req.file) {
                photoPath = await uploadBuffer(req.file.buffer, 'concerns', req.file.originalname, req.file.mimetype);
            }

            await query(
                `INSERT INTO community_concerns (
                    concern_id, user_id, resident_name, resident_email, contact_number, address,
                    title, category, description, location, incident_date, photo_path, status,
                    created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12, 'Pending', NOW(), NOW()
                )`,
                [
                    concernId,
                    user.id,
                    user.name,
                    user.email,
                    user.phone_number || 'N/A',
                    address,
                    b.title || `${b.category} Report`,
                    b.category,
                    b.description,
                    b.location || 'Not specified',
                    b.incident_date || new Date().toISOString().slice(0, 10),
                    photoPath,
                ]
            );

            await ActivityLog.record('Submitted Concern', `Reported an issue: ${b.category}`, user.id, req);
            return res.redirectWithFlash('/resident/community-concerns', 'success', 'Your community concern has been submitted successfully!');
        }
    );

    app.get('/resident/community-concerns/:concern/photo/:filename?', ...residentGuard('resident.concerns.photo'), async (req, res) => {
        const concern = await queryOne('SELECT * FROM community_concerns WHERE id = $1 LIMIT 1', [req.params.concern]);
        if (!concern) return res.status(404).send('Concern photo not found.');
        if (Number(concern.user_id) !== Number(req.user.id)) return res.status(403).send('Unauthorized.');
        return serveFile(res, concern.photo_path, { directoryHints: ['concerns'], notFoundMessage: 'Concern photo not found.' });
    });

    app.get('/resident/community-concerns/:concern/remarks/:remark/attachment', ...residentGuard('resident.concerns.remarks.attachment'), async (req, res) => {
        const concern = await queryOne('SELECT * FROM community_concerns WHERE id = $1 LIMIT 1', [req.params.concern]);
        const remark = await queryOne('SELECT * FROM community_concern_remarks WHERE id = $1 LIMIT 1', [req.params.remark]);
        if (!concern || !remark) return res.status(404).send('Feedback attachment not found.');
        if (Number(concern.user_id) !== Number(req.user.id)) return res.status(403).send('Unauthorized.');
        if (Number(remark.community_concern_id) !== Number(concern.id)) return res.status(404).send('Feedback attachment not found.');
        if (!remark.attachment_path || !String(remark.attachment_path).startsWith('community-concern-feedback/')) {
            return res.status(404).send('Feedback attachment not found.');
        }
        return serveFile(res, remark.attachment_path, {
            directoryHints: ['community-concern-feedback'],
            notFoundMessage: 'Feedback attachment not found.',
        });
    });
}
