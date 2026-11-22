import rateLimit from 'express-rate-limit';

function createLimiter(max, windowMs = 60 * 1000, message = 'Too many requests. Please wait a moment and try again.') {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            const wantsJson = req.xhr || req.headers.accept?.includes('application/json');
            if (wantsJson) {
                return res.status(429).json({ success: false, message });
            }
            return res.status(429).send(message);
        },
    });
}

export const limit10PerMin = createLimiter(10, 60 * 1000);
export const limit6PerMin = createLimiter(6, 60 * 1000);
export const limit5PerMin = createLimiter(5, 60 * 1000);
export const limit20PerMin = createLimiter(20, 60 * 1000);
