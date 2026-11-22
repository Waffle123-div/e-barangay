const ROUTE_DEFINITIONS = {
    'welcome': () => '/',
    'home': () => '/home',
    'csrf_token': () => '/csrf-token',
    'branding.asset': (p = {}) => {
        const key = p.key ?? p[0] ?? '';
        const fn = p.filename ?? p[1];
        return fn ? `/branding/${encodeURIComponent(key)}/${encodeURIComponent(fn)}` : `/branding/${encodeURIComponent(key)}`;
    },
    'media.profile_avatar': (p = {}) => {
        const fn = typeof p === 'string' ? p : (p.filename ?? p[0]);
        return fn ? `/media/profile-avatar/${encodeURIComponent(fn)}` : '/media/profile-avatar';
    },

    // Google OAuth
    'google.login': () => '/auth/google',
    'google.callback': () => '/auth/google/callback',

    // Admin Auth
    'admin.login': () => '/admin/login',
    'admin.login.submit': () => '/admin/login',
    'admin.logout': () => '/admin/logout',

    // Admin Portal
    'admin.dashboard': () => '/admin',
    'admin.users': () => '/admin/users',
    'admin.users.store': () => '/admin/users',
    'admin.users.bulk-delete': () => '/admin/users/bulk-delete',
    'admin.users.view': (p) => `/admin/users/${extractParam(p, 'id')}`,
    'admin.users.update': (p) => `/admin/users/${extractParam(p, 'id')}/update`,
    'admin.users.toggle-status': (p) => `/admin/users/${extractParam(p, 'id')}/toggle-status`,
    'admin.users.destroy': (p) => `/admin/users/${extractParam(p, 'id')}`,

    'admin.requests': () => '/admin/requests',
    'admin.requests.walk-in': () => '/admin/requests/walk-in',
    'admin.requests.generate': (p) => `/admin/requests/generate/${extractParam(p, 'id')}`,
    'admin.requests.show': (p) => `/admin/requests/${extractParam(p, 'id')}`,
    'admin.requests.bulk-delete': () => '/admin/requests/bulk-delete',
    'admin.requests.destroy': (p) => `/admin/requests/${extractParam(p, 'id')}`,
    'admin.requests.accept': (p) => `/admin/requests/${extractParam(p, 'id')}/accept`,
    'admin.requests.reject': (p) => `/admin/requests/${extractParam(p, 'id')}/reject`,
    'admin.requests.ready': (p) => `/admin/requests/${extractParam(p, 'id')}/ready`,
    'admin.requests.complete': (p) => `/admin/requests/${extractParam(p, 'id')}/complete`,
    'admin.requests.update': (p) => `/admin/requests/${extractParam(p, 'id')}/update`,
    'admin.requests.updateFee': (p) => `/admin/requests/${extractParam(p, 'id')}/fee`,
    'admin.requests.attachment': (p = {}) => {
        const reqId = p.documentRequest?.id ?? p.documentRequest ?? p[0] ?? '';
        const idx = p.index ?? p[1] ?? 0;
        const fn = p.filename ?? p[2];
        return fn
            ? `/admin/requests/${encodeURIComponent(reqId)}/attachment/${encodeURIComponent(idx)}/${encodeURIComponent(fn)}`
            : `/admin/requests/${encodeURIComponent(reqId)}/attachment/${encodeURIComponent(idx)}`;
    },

    'admin.reports': () => '/admin/reports',
    'admin.profile': () => '/admin/profile',
    'admin.profile.avatar': (p = {}) => {
        const fn = typeof p === 'string' ? p : (p.filename ?? p[0]);
        return fn ? `/admin/profile/avatar/${encodeURIComponent(fn)}` : '/admin/profile/avatar';
    },
    'admin.profile.update': () => '/admin/profile/update',

    'admin.resident.selfie': (p = {}) => {
        const fn = typeof p === 'string' ? p : (p.filename ?? p[0] ?? '');
        return `/admin/resident-selfie/${encodeURIComponent(fn)}`;
    },
    'admin.resident.id_document': (p = {}) => {
        const uid = p.user?.id ?? p.user ?? p[0] ?? '';
        const fn = p.filename ?? p[1];
        return fn
            ? `/admin/resident-id-document/${encodeURIComponent(uid)}/${encodeURIComponent(fn)}`
            : `/admin/resident-id-document/${encodeURIComponent(uid)}`;
    },

    'admin.approvals': () => '/admin/account-approvals',
    'admin.approvals.bulk-approve': () => '/admin/account-approvals/bulk-approve',
    'admin.approvals.bulk-reject': () => '/admin/account-approvals/bulk-reject',
    'admin.approvals.approve': (p) => `/admin/account-approvals/${extractParam(p, 'id')}/approve`,
    'admin.approvals.reject': (p) => `/admin/account-approvals/${extractParam(p, 'id')}/reject`,

    'admin.activity-logs': () => '/admin/activity-logs',
    'admin.activity-logs.bulk-delete': () => '/admin/activity-logs/bulk-delete',
    'admin.activity-logs.destroy': (p) => `/admin/activity-logs/${extractParam(p, 'id')}`,

    'admin.concerns': () => '/admin/concerns',
    'admin.concerns.photo': (p = {}) => {
        const cid = p.concern?.id ?? p.concern ?? p[0] ?? '';
        const fn = p.filename ?? p[1];
        return fn ? `/admin/concerns/${encodeURIComponent(cid)}/photo/${encodeURIComponent(fn)}` : `/admin/concerns/${encodeURIComponent(cid)}/photo`;
    },
    'admin.concerns.remarks.attachment': (p = {}) => {
        const cid = p.concern?.id ?? p.concern ?? p[0] ?? '';
        const rid = p.remark?.id ?? p.remark ?? p[1] ?? '';
        return `/admin/concerns/${encodeURIComponent(cid)}/remarks/${encodeURIComponent(rid)}/attachment`;
    },
    'admin.concerns.update': (p) => `/admin/concerns/${extractParam(p, 'id')}`,

    'admin.document-types.index': () => '/admin/document-types',
    'admin.documents.index': () => '/admin/document-management',
    'admin.document-types.store': () => '/admin/document-types',
    'admin.document-types.update': (p) => `/admin/document-types/${extractParam(p, 'id')}`,
    'admin.document-types.toggle-status': (p) => `/admin/document-types/${extractParam(p, 'id')}/toggle-status`,
    'admin.document-types.bulk-delete': () => '/admin/document-types/bulk-delete',
    'admin.document-types.destroy': (p) => `/admin/document-types/${extractParam(p, 'id')}`,
    'admin.document-types.download-template': (p) => `/admin/document-types/${extractParam(p, 'id')}/template`,

    'admin.settings': () => '/admin/settings',
    'admin.settings.profile': () => '/admin/settings/profile',
    'admin.settings.password': () => '/admin/settings/password',
    'admin.settings.barangay': () => '/admin/settings/barangay',
    'admin.settings.backup-db': () => '/admin/settings/backup-db',
    'admin.notifications.get': () => '/admin/notifications',
    'admin.notifications.read': () => '/admin/notifications/mark-read',

    // Verification
    'verification.notice': () => '/email/verify',
    'verification.send': () => '/email/verification-notification',
    'verification.verify': (p = {}) => `/email/verify/${extractParam(p, 'id')}/${p.hash ?? p[1] ?? ''}`,
    'verify_phone.notice': () => '/phone/verify',
    'verify_phone.submit': () => '/phone/verify',

    // Resident Auth
    'resident.login': () => '/resident/login',
    'resident.login.submit': () => '/resident/login',
    'resident.forgot_password': () => '/resident/forgot-password',
    'resident.forgot_password.search': () => '/resident/forgot-password/search',
    'resident.forgot_password.send': () => '/resident/forgot-password/send',
    'resident.forgot_password.verify': () => '/resident/forgot-password/verify',
    'resident.forgot_password.verify.submit': () => '/resident/forgot-password/verify',
    'resident.forgot_password.reset': () => '/resident/forgot-password/reset',
    'resident.forgot_password.reset.submit': () => '/resident/forgot-password/reset',
    'resident.forgot_password.success': () => '/resident/forgot-password/success',
    'resident.register': () => '/resident/register',
    'resident.register.submit': () => '/resident/register',
    'resident.register.send_otp': () => '/resident/register/send-otp',
    'resident.register.verify_otp': () => '/resident/register/verify-otp',
    'resident.logout': () => '/resident/logout',

    'register.complete': () => '/complete-registration',
    'register.complete.submit': () => '/complete-registration',
    'resident.pending': () => '/resident/pending-approval',
    'resident.pin.setup': () => '/resident/setup-pin',

    // Resident Portal
    'resident.dashboard': () => '/resident',
    'resident.request.create': () => '/resident/request-document',
    'resident.request.store': () => '/resident/request-document',
    'resident.request.track': () => '/resident/track-request',
    'resident.requests.check': () => '/resident/requests/check-updates',

    'resident.concerns': () => '/resident/community-concerns',
    'resident.concern.store': () => '/resident/community-concerns',
    'resident.concerns.photo': (p = {}) => {
        const cid = p.concern?.id ?? p.concern ?? p[0] ?? '';
        const fn = p.filename ?? p[1];
        return fn ? `/resident/community-concerns/${encodeURIComponent(cid)}/photo/${encodeURIComponent(fn)}` : `/resident/community-concerns/${encodeURIComponent(cid)}/photo`;
    },
    'resident.concerns.remarks.attachment': (p = {}) => {
        const cid = p.concern?.id ?? p.concern ?? p[0] ?? '';
        const rid = p.remark?.id ?? p.remark ?? p[1] ?? '';
        return `/resident/community-concerns/${encodeURIComponent(cid)}/remarks/${encodeURIComponent(rid)}/attachment`;
    },

    'resident.session.lock': () => '/resident/session/lock',
    'resident.session.unlock': () => '/resident/session/unlock',
    'resident.notifications.get': () => '/resident/notifications',
    'resident.notifications.read': () => '/resident/notifications/mark-read',
    'resident.activity-logs': () => '/resident/activity-logs',
    'resident.receipt.view': (p) => `/resident/receipt/${extractParam(p, 'id')}`,
    'resident.receipt.download': (p) => `/resident/receipt/${extractParam(p, 'id')}/download`,
    'receipt.view': (p) => `/receipt/${extractParam(p, 'id')}`,
    'receipt.download': (p) => `/receipt/${extractParam(p, 'id')}/download`,

    // Resident Settings
    'resident.settings': () => '/resident/settings',
    'resident.settings.file': (p = {}) => {
        const type = p.type ?? p[0] ?? '';
        const fn = p.filename ?? p[1];
        return fn ? `/resident/settings/file/${encodeURIComponent(type)}/${encodeURIComponent(fn)}` : `/resident/settings/file/${encodeURIComponent(type)}`;
    },
    'resident.settings.send_otp': () => '/resident/settings/send-otp',
    'resident.settings.verify_otp': () => '/resident/settings/verify-otp',
    'resident.settings.profile': () => '/resident/settings/profile',
    'resident.settings.account': () => '/resident/settings/account',
    'resident.settings.password': () => '/resident/settings/password',
    'resident.settings.security': () => '/resident/settings/security',
    'resident.settings.id': () => '/resident/settings/id',
    'resident.settings.logout-others': () => '/resident/settings/logout-others',
    'resident.settings.logout-all': () => '/resident/settings/logout-all',
    'resident.settings.deactivate': () => '/resident/settings/deactivate',
    'resident.settings.delete': () => '/resident/settings/delete',

    // Chatbot
    'chatbot.message': () => '/chatbot/message',
};

const STANDARD_PARAM_KEYS = new Set(['0', '1', '2', 'id', 'user', 'documentRequest', 'concern', 'remark', 'filename', 'index', 'key', 'type', 'hash']);

function extractParam(params, key) {
    if (params === null || params === undefined) return '';
    if (typeof params === 'string' || typeof params === 'number') return encodeURIComponent(String(params));
    if (Array.isArray(params)) return encodeURIComponent(String(params[0] ?? ''));
    if (typeof params === 'object') {
        if (params[key] !== undefined) {
            const val = typeof params[key] === 'object' && params[key] !== null ? params[key].id : params[key];
            return encodeURIComponent(String(val ?? ''));
        }
        if (params.id !== undefined) return encodeURIComponent(String(params.id));
        if (params[0] !== undefined) {
            const val = typeof params[0] === 'object' && params[0] !== null ? params[0].id : params[0];
            return encodeURIComponent(String(val ?? ''));
        }
    }
    return '';
}

export function route(name, params = {}, absolute = false, baseUrl = '') {
    const builder = ROUTE_DEFINITIONS[name];
    if (!builder) {
        throw new Error(`Route [${name}] not defined.`);
    }

    let pathname = builder(params || {});

    if (params && typeof params === 'object' && !Array.isArray(params) && !['string', 'number'].includes(typeof params)) {
        const queryPairs = [];
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null || v === '') continue;
            if (STANDARD_PARAM_KEYS.has(k)) continue;
            queryPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
        if (queryPairs.length > 0 && !['admin.requests.attachment', 'admin.concerns.photo', 'admin.concerns.remarks.attachment', 'resident.concerns.photo', 'resident.concerns.remarks.attachment', 'admin.resident.id_document', 'branding.asset', 'resident.settings.file', 'verification.verify'].includes(name)) {
            pathname += (pathname.includes('?') ? '&' : '?') + queryPairs.join('&');
        } else if (name === 'admin.requests' || name === 'resident.settings' || name === 'admin.users' || name === 'admin.activity-logs' || name === 'admin.approvals' || name === 'admin.concerns' || name === 'admin.document-types.index') {
            // handled by general queryPairs above
        }
    }

    if (absolute && baseUrl) {
        return `${baseUrl.replace(/\/+$/, '')}${pathname}`;
    }
    return pathname;
}

export function routeIs(currentRouteName, ...patterns) {
    if (!currentRouteName) return false;
    return patterns.flat().some((pattern) => {
        if (!pattern) return false;
        const regex = new RegExp('^' + String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return regex.test(currentRouteName);
    });
}
