import cookieParser from 'cookie-parser';
import express from 'express';
import methodOverride from 'method-override';
import path from 'path';
import { env, ROOT_DIR } from './config/env.js';
import { attachViewHelpers } from './lib/viewHelpers.js';
import { loadUser } from './middleware/auth.js';
import { attachCsrfLocals, verifyCsrf } from './middleware/csrf.js';
import { flashMiddleware } from './middleware/flash.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { createSessionMiddleware, trackSessionMeta } from './middleware/session.js';
import { registerAdminAuthRoutes } from './routes/adminAuth.js';
import { registerAdminPortalRoutes } from './routes/adminPortal.js';
import { registerGoogleAuthRoutes } from './routes/googleAuth.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerResidentAuthRoutes } from './routes/residentAuth.js';
import { registerResidentPortalRoutes } from './routes/residentPortal.js';
import { registerResidentSettingsRoutes } from './routes/residentSettings.js';
import { registerVerificationRoutes } from './routes/verification.js';

export function createApp() {
    const app = express();

    app.set('trust proxy', 1);
    app.set('view engine', 'ejs');
    app.set('views', path.join(ROOT_DIR, 'views'));
    app.set('view options', { root: path.join(ROOT_DIR, 'views') });

    app.use(securityHeaders);
    app.use(
        express.static(path.join(ROOT_DIR, 'public'), {
            maxAge: env.isProduction ? '1d' : 0,
        })
    );

    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(express.json({ limit: '10mb' }));
    app.use(
        methodOverride((req) => {
            if (req.body && typeof req.body === 'object' && '_method' in req.body) {
                const method = req.body._method;
                delete req.body._method;
                return method;
            }
            return undefined;
        })
    );

    app.use(createSessionMiddleware());
    app.use(trackSessionMeta);
    app.use(attachCsrfLocals);
    app.use(flashMiddleware);
    app.use(loadUser);
    app.use(attachViewHelpers);
    app.use(verifyCsrf);

    registerPublicRoutes(app);
    registerGoogleAuthRoutes(app);
    registerVerificationRoutes(app);
    registerAdminAuthRoutes(app);
    registerAdminPortalRoutes(app);
    registerResidentAuthRoutes(app);
    registerResidentPortalRoutes(app);
    registerResidentSettingsRoutes(app);

    // 404 handler
    app.use((req, res) => {
        res.status(404).send('404 | Page Not Found');
    });

    // Global error handler (including multer upload validation errors)
    app.use((err, req, res, next) => {
        if (err?.code === 'LIMIT_FILE_SIZE' || err?.isUploadValidation) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Uploaded file exceeds the maximum allowed size.'
                : err.message;
            if (req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(422).json({ success: false, message: msg });
            }
            return res.redirectBackWithErrors({ file: msg }, false, req.get('referer') || '/');
        }

        console.error('[Express Error]', err);
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(err.status || 500).json({
                success: false,
                message: env.isProduction ? 'Internal server error.' : err.message,
            });
        }
        res.status(err.status || 500).send(env.isProduction ? 'Server Error' : `Server Error: ${err.message}`);
    });

    return app;
}

const app = createApp();
export default app;
