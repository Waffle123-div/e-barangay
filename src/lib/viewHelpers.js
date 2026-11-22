import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { env, getRequestBaseUrl, ROOT_DIR } from '../config/env.js';
import { route, routeIs } from './routeMap.js';
import { settingImageUrl } from '../services/storageService.js';

const assetVersionCache = new Map();

export const STR_PAD_LEFT = 'left';
export const STR_PAD_RIGHT = 'right';
export const STR_PAD_BOTH = 'both';

export function str_pad(input, targetLen, padStr = ' ', padType = STR_PAD_RIGHT) {
    const s = String(input ?? '');
    const len = Number(targetLen) || 0;
    const pad = String(padStr ?? ' ');
    if (s.length >= len || !pad) return s;
    if (padType === STR_PAD_LEFT) return s.padStart(len, pad);
    if (padType === STR_PAD_BOTH) {
        const total = len - s.length;
        const left = Math.floor(total / 2);
        return s.padStart(s.length + left, pad).padEnd(len, pad);
    }
    return s.padEnd(len, pad);
}

export function phpSubstr(str, start, length) {
    const s = String(str ?? '');
    let st = Number(start) || 0;
    if (st < 0) st = Math.max(0, s.length + st);
    if (length === undefined) return s.slice(st);
    const len = Number(length) || 0;
    if (len < 0) return s.slice(st, Math.max(st, s.length + len));
    return s.slice(st, st + len);
}

export function phpTrim(str) {
    return String(str ?? '').trim();
}

export function collect(val = []) {
    return Array.isArray(val) ? val : [];
}

export function strip_tags(str) {
    return String(str ?? '').replace(/<[^>]*>/g, '');
}

export function url(pathStr = '') {
    const s = String(pathStr ?? '');
    if (/^https?:\/\//i.test(s)) return s;
    return '/' + s.replace(/^\/+/, '');
}

export function is_null(v) {
    return v === null || v === undefined;
}

export function round(value, precision = 0) {
    const n = Number(value) || 0;
    const factor = Math.pow(10, Number(precision) || 0);
    return Math.round(n * factor) / factor;
}

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function versionedAsset(relPath) {
    const clean = String(relPath || '').replace(/^\/+/, '');
    if (!assetVersionCache.has(clean)) {
        let ver = '1';
        try {
            const stat = fs.statSync(path.join(ROOT_DIR, 'public', clean));
            ver = String(Math.floor(stat.mtimeMs / 1000));
        } catch (_) {}
        assetVersionCache.set(clean, ver);
    }
    return `/${clean}?v=${assetVersionCache.get(clean)}`;
}

export function asset(relPath) {
    const clean = String(relPath || '').replace(/^\/+/, '');
    return `/${clean}`;
}

export function md5(val) {
    return crypto.createHash('md5').update(String(val ?? '')).digest('hex');
}

export function numberFormat(value, decimals = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return (0).toFixed(decimals);
    return n.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

const MONTHS_FULL = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ordinalSuffix(day) {
    if (day > 3 && day < 21) return 'th';
    switch (day % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}

export function formatDate(val, pattern = 'M d, Y') {
    if (!val) return '';
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);

    const year = d.getFullYear();
    const month = d.getMonth();
    const day = d.getDate();
    const hours24 = d.getHours();
    const hours12 = hours24 % 12 || 12;
    const mins = String(d.getMinutes()).padStart(2, '0');
    const secs = String(d.getSeconds()).padStart(2, '0');
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    const dayPad = String(day).padStart(2, '0');
    const monthPad = String(month + 1).padStart(2, '0');

    if (pattern === 'Y-m-d') return `${year}-${monthPad}-${dayPad}`;
    if (pattern === 'F d, Y') return `${MONTHS_FULL[month]} ${dayPad}, ${year}`;
    if (pattern === 'M d, Y') return `${MONTHS_SHORT[month]} ${dayPad}, ${year}`;
    if (pattern === 'M d, Y h:i A') return `${MONTHS_SHORT[month]} ${dayPad}, ${year} ${String(hours12).padStart(2, '0')}:${mins} ${ampm}`;
    if (pattern === 'M d, Y · h:i A') return `${MONTHS_SHORT[month]} ${dayPad}, ${year} · ${String(hours12).padStart(2, '0')}:${mins} ${ampm}`;
    if (pattern === 'F d, Y — h:i A') return `${MONTHS_FULL[month]} ${dayPad}, ${year} — ${String(hours12).padStart(2, '0')}:${mins} ${ampm}`;
    if (pattern === 'h:i A') return `${String(hours12).padStart(2, '0')}:${mins} ${ampm}`;
    if (pattern === 'Y') return String(year);
    if (pattern === 'F') return MONTHS_FULL[month];
    if (pattern === 'jS') return `${day}${ordinalSuffix(day)}`;
    if (pattern === 'jS day of F, Y') return `${day}${ordinalSuffix(day)} day of ${MONTHS_FULL[month]}, ${year}`;
    if (pattern === 'M j, Y') return `${MONTHS_SHORT[month]} ${day}, ${year}`;
    if (pattern === 'M j, Y g:i A') return `${MONTHS_SHORT[month]} ${day}, ${year} ${hours12}:${mins} ${ampm}`;
    if (pattern === 'F j, Y') return `${MONTHS_FULL[month]} ${day}, ${year}`;
    if (pattern === 'Y-m-d H:i:s') return `${year}-${monthPad}-${dayPad} ${String(hours24).padStart(2, '0')}:${mins}:${secs}`;

    return pattern
        .replace(/Y/g, String(year))
        .replace(/m/g, monthPad)
        .replace(/d/g, dayPad)
        .replace(/jS/g, `${day}${ordinalSuffix(day)}`)
        .replace(/j/g, String(day))
        .replace(/F/g, MONTHS_FULL[month])
        .replace(/M/g, MONTHS_SHORT[month])
        .replace(/H/g, String(hours24).padStart(2, '0'))
        .replace(/h/g, String(hours12).padStart(2, '0'))
        .replace(/g/g, String(hours12))
        .replace(/i/g, mins)
        .replace(/s/g, secs)
        .replace(/A/g, ampm);
}

export function diffForHumans(val) {
    if (!val) return '';
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return '';
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec} second${diffSec === 1 ? '' : 's'} ago`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function diffInHours(val) {
    if (!val) return 0;
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return 0;
    return Math.abs(Date.now() - d.getTime()) / 3600000;
}

export function isPast(val) {
    if (!val) return false;
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return false;
    return d.getTime() < Date.now();
}

export function calcAge(val) {
    if (!val) return null;
    const d = val instanceof Date ? val : new Date(val);
    if (Number.isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age;
}

export function renderPagination(paginator) {
    if (!paginator || paginator.lastPage <= 1) return '';
    const { currentPage, lastPage, baseUrl, query = {}, firstItem, lastItem, total } = paginator;

    const buildUrl = (page) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query || {})) {
            if (k === 'page' || v === undefined || v === null || v === '') continue;
            params.set(k, String(v));
        }
        params.set('page', String(page));
        const qs = params.toString();
        return qs ? `${baseUrl}?${qs}` : baseUrl;
    };

    const items = [];
    if (currentPage <= 1) {
        items.push(`<li class="page-item disabled" aria-disabled="true"><span class="page-link">&lsaquo;</span></li>`);
    } else {
        items.push(`<li class="page-item"><a class="page-link" href="${escapeHtml(buildUrl(currentPage - 1))}" rel="prev">&lsaquo;</a></li>`);
    }

    const start = Math.max(1, currentPage - 2);
    const end = Math.min(lastPage, currentPage + 2);

    if (start > 1) {
        items.push(`<li class="page-item"><a class="page-link" href="${escapeHtml(buildUrl(1))}">1</a></li>`);
        if (start > 2) items.push(`<li class="page-item disabled"><span class="page-link">...</span></li>`);
    }

    for (let p = start; p <= end; p++) {
        if (p === currentPage) {
            items.push(`<li class="page-item active" aria-current="page"><span class="page-link">${p}</span></li>`);
        } else {
            items.push(`<li class="page-item"><a class="page-link" href="${escapeHtml(buildUrl(p))}">${p}</a></li>`);
        }
    }

    if (end < lastPage) {
        if (end < lastPage - 1) items.push(`<li class="page-item disabled"><span class="page-link">...</span></li>`);
        items.push(`<li class="page-item"><a class="page-link" href="${escapeHtml(buildUrl(lastPage))}">${lastPage}</a></li>`);
    }

    if (currentPage >= lastPage) {
        items.push(`<li class="page-item disabled" aria-disabled="true"><span class="page-link">&rsaquo;</span></li>`);
    } else {
        items.push(`<li class="page-item"><a class="page-link" href="${escapeHtml(buildUrl(currentPage + 1))}" rel="next">&rsaquo;</a></li>`);
    }

    return `<nav class="d-flex justify-items-center justify-content-between"><div class="d-none flex-sm-fill d-sm-flex align-items-sm-center justify-content-sm-between"><div><p class="small text-muted mb-0">Showing <span class="fw-semibold">${firstItem}</span> to <span class="fw-semibold">${lastItem}</span> of <span class="fw-semibold">${total}</span> results</p></div><div><ul class="pagination mb-0">${items.join('')}</ul></div></div><div class="d-flex justify-content-between flex-fill d-sm-none"><ul class="pagination mb-0">${items.join('')}</ul></div></nav>`;
}

export function attachViewHelpers(req, res, next) {
    const baseUrl = getRequestBaseUrl(req);
    const currentRouteName = req.routeName || '';

    res.locals.route = (name, params = {}, absolute = false) => route(name, params, absolute, baseUrl);
    res.locals.routeIs = (...patterns) => routeIs(req.routeName || res.locals.currentRoute || '', ...patterns);
    res.locals.currentRoute = currentRouteName;
    res.locals.asset = asset;
    res.locals.versionedAsset = versionedAsset;
    res.locals.settingImageUrl = settingImageUrl;
    res.locals.config = (key, fallback = null) => {
        if (key === 'services.recaptcha.site_key') return env.recaptchaSiteKey || fallback;
        if (key === 'app.name') return env.appName || fallback;
        if (key === 'app.url') return baseUrl || env.appUrl || fallback;
        return fallback;
    };

    const fullUrlWithQuery = (overrides = {}) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(req.query || {})) {
            if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
        }
        for (const [k, v] of Object.entries(overrides || {})) {
            if (v === undefined || v === null || v === '') params.delete(k);
            else params.set(k, String(v));
        }
        const qs = params.toString();
        return qs ? `${req.path}?${qs}` : req.path;
    };

    res.locals.fullUrlWithQuery = fullUrlWithQuery;
    res.locals.request = (k, def = null) => {
        if (k === undefined) {
            return {
                query: req.query || {},
                path: req.path,
                fullUrlWithQuery,
            };
        }
        return req.query?.[k] ?? req.body?.[k] ?? def;
    };
    res.locals.requestInput = (k, def = null) => req.query?.[k] ?? req.body?.[k] ?? def;
    res.locals.requestFilled = (k) => {
        const v = req.query?.[k] ?? req.body?.[k];
        return v !== undefined && v !== null && String(v).trim() !== '';
    };
    res.locals.requestHas = (k) => Object.prototype.hasOwnProperty.call(req.query || {}, k) || Object.prototype.hasOwnProperty.call(req.body || {}, k);

    res.locals.formatDate = formatDate;
    res.locals.diffForHumans = diffForHumans;
    res.locals.diffInHours = diffInHours;
    res.locals.isPast = isPast;
    res.locals.calcAge = calcAge;
    res.locals.numberFormat = numberFormat;
    res.locals.md5 = md5;
    res.locals.e = escapeHtml;
    res.locals.nl2br = (s) => escapeHtml(s).replace(/\r?\n/g, '<br>');
    res.locals.ucwords = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
    res.locals.ucfirst = (s) => {
        const str = String(s || '');
        return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
    };
    res.locals.strLimit = (s, len = 100) => {
        const str = String(s || '');
        return str.length > len ? str.slice(0, len) + '...' : str;
    };
    res.locals.str_pad = str_pad;
    res.locals.STR_PAD_LEFT = STR_PAD_LEFT;
    res.locals.STR_PAD_RIGHT = STR_PAD_RIGHT;
    res.locals.STR_PAD_BOTH = STR_PAD_BOTH;
    res.locals.phpSubstr = phpSubstr;
    res.locals.phpTrim = phpTrim;
    res.locals.collect = collect;
    res.locals.strip_tags = strip_tags;
    res.locals.url = url;
    res.locals.is_null = is_null;
    res.locals.round = round;
    res.locals.addslashes = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    res.locals.basename = (p) => path.posix.basename(String(p || '').replace(/\\/g, '/'));
    res.locals.isValidUrl = (s) => /^https?:\/\//i.test(String(s || ''));
    res.locals.tomorrowIso = formatDate(new Date(Date.now() + 86400000), 'Y-m-d');
    res.locals.renderPagination = renderPagination;
    res.locals.currentYear = new Date().getFullYear();
    res.locals.todayIso = formatDate(new Date(), 'Y-m-d');
    res.locals.method_field = (m) => `<input type="hidden" name="_method" value="${escapeHtml(m)}">`;
    res.locals.sessionHas = (k) => {
        const v = res.locals.sessionGet(k);
        return v !== null && v !== undefined && v !== '' && v !== false;
    };
    res.locals.appEnvLabel = String(env.nodeEnv || 'production').toUpperCase();
    res.locals.appVersionLabel = 'v2.0 (Node.js)';
    res.locals.runtimeVersionLabel = `Node ${process.version}`;

    next();
}
