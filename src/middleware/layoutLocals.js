import { queryOne } from '../db/pool.js';
import { BarangaySetting, NotificationService } from '../lib/models.js';
import { getClientRealtimeConfig } from '../services/realtimeService.js';
import { settingImageUrl } from '../services/storageService.js';

export async function populateAdminLayoutLocals(req, res, next) {
    try {
        const [reqRow, appRow, conRow, barangayLogo] = await Promise.all([
            queryOne("SELECT COUNT(*)::int AS cnt FROM document_requests WHERE status IN ('Pending', 'Under Review')"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM users WHERE status IN ('pending_approval', 'Pending', 'pending') AND LOWER(role) = 'resident'"),
            queryOne("SELECT COUNT(*)::int AS cnt FROM community_concerns WHERE status = 'Pending'"),
            BarangaySetting.get('barangay_logo'),
        ]);

        res.locals.pendingRequestsCount = reqRow?.cnt || 0;
        res.locals.pendingApprovalsCount = appRow?.cnt || 0;
        res.locals.pendingConcernsCount = conRow?.cnt || 0;
        res.locals.logoUrl = settingImageUrl('barangay_logo', barangayLogo) || '/images/logo.png';
        res.locals.realtimeConfig = getClientRealtimeConfig(req.user);
    } catch (err) {
        console.error('[populateAdminLayoutLocals]', err.message);
        res.locals.pendingRequestsCount = 0;
        res.locals.pendingApprovalsCount = 0;
        res.locals.pendingConcernsCount = 0;
        res.locals.logoUrl = '/images/logo.png';
        res.locals.realtimeConfig = null;
    }
    next();
}

export async function populateResidentLayoutLocals(req, res, next) {
    try {
        if (req.user) {
            const [activeRow, notifData] = await Promise.all([
                queryOne(
                    "SELECT COUNT(*)::int AS cnt FROM document_requests WHERE user_id = $1 AND status NOT IN ('Completed', 'Rejected', 'Cancelled')",
                    [req.user.id]
                ),
                NotificationService.getUserNotifications(req.user.id, 15),
            ]);
            res.locals.residentActiveRequestsCount = activeRow?.cnt || 0;
            res.locals.unreadNotifCount = notifData.unreadCount;
            res.locals.userNotifs = notifData.notifications;
            res.locals.realtimeConfig = getClientRealtimeConfig(req.user);
        } else {
            res.locals.residentActiveRequestsCount = 0;
            res.locals.unreadNotifCount = 0;
            res.locals.userNotifs = [];
            res.locals.realtimeConfig = null;
        }
    } catch (err) {
        console.error('[populateResidentLayoutLocals]', err.message);
        res.locals.residentActiveRequestsCount = 0;
        res.locals.unreadNotifCount = 0;
        res.locals.userNotifs = [];
        res.locals.realtimeConfig = null;
    }
    next();
}
