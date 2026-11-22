export function flashMiddleware(req, res, next) {
    const incomingFlash = req.session?._flash || {};
    const incomingOld = req.session?._old || {};
    const incomingErrors = req.session?._errors || {};

    if (req.session) {
        delete req.session._flash;
        delete req.session._old;
        delete req.session._errors;
    }

    const activeFlash = { ...incomingFlash };
    const activeOld = { ...incomingOld };
    const activeErrors = { ...incomingErrors };

    req.flash = (key, value) => {
        if (!req.session) return;
        if (!req.session._flash) req.session._flash = {};
        req.session._flash[key] = value;
    };

    req.flashOld = (inputObj = null) => {
        if (!req.session) return;
        const src = inputObj || req.body || {};
        const filtered = {};
        for (const [k, v] of Object.entries(src)) {
            if (/password|pin|_token|_method/i.test(k)) continue;
            filtered[k] = v;
        }
        req.session._old = filtered;
    };

    req.flashErrors = (errorsObj) => {
        if (!req.session) return;
        const normalized = {};
        for (const [k, v] of Object.entries(errorsObj || {})) {
            normalized[k] = Array.isArray(v) ? v : [String(v)];
        }
        req.session._errors = normalized;
    };

    res.redirectWithFlash = (url, keyOrObj, val = undefined) => {
        if (typeof keyOrObj === 'string' && val !== undefined) {
            req.flash(keyOrObj, val);
        } else if (keyOrObj && typeof keyOrObj === 'object') {
            for (const [k, v] of Object.entries(keyOrObj)) {
                req.flash(k, v);
            }
        }
        return res.redirect(url);
    };

    res.redirectBackWithErrors = (errorsObj, oldInput = null, fallbackUrl = '/') => {
        req.flashErrors(errorsObj);
        if (oldInput !== false) {
            req.flashOld(oldInput || req.body);
        }
        const ref = req.get('referer');
        return res.redirect(ref && !ref.includes('/undefined') ? ref : fallbackUrl);
    };

    res.locals.flash = activeFlash;
    res.locals.sessionGet = (key, defaultVal = null) => {
        if (Object.prototype.hasOwnProperty.call(activeFlash, key)) return activeFlash[key];
        if (req.session && Object.prototype.hasOwnProperty.call(req.session, key)) return req.session[key];
        return defaultVal;
    };
    res.locals.old = (key, defaultVal = '') => {
        if (Object.prototype.hasOwnProperty.call(activeOld, key)) return activeOld[key] ?? defaultVal;
        return defaultVal;
    };
    res.locals.errors = {
        all: () => Object.values(activeErrors).flat(),
        any: () => Object.values(activeErrors).flat().length > 0,
        has: (field) => Array.isArray(activeErrors[field]) && activeErrors[field].length > 0,
        first: (field) => (Array.isArray(activeErrors[field]) && activeErrors[field][0]) || null,
        bag: activeErrors,
    };

    next();
}
