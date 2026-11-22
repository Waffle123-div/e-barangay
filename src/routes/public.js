import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { BarangaySetting, hydrateDocumentType, NotificationService } from '../lib/models.js';
import { limit20PerMin } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';
import { serveFile } from '../services/storageService.js';

export function registerPublicRoutes(app) {
    // Landing Page (Root Route) — matches routes/web.php: logs out authenticated session
    app.get('/', async (req, res) => {
        req.routeName = 'welcome';
        res.locals.currentRoute = 'welcome';

        if (req.user) {
            await new Promise((resolve) => req.session.regenerate(() => resolve()));
            req.user = null;
            res.locals.authUser = null;
            res.locals.isAuthenticated = false;
            res.locals.isAdmin = false;
            res.locals.isResident = false;
        }

        let portalDocs = [];
        try {
            const { rows } = await query('SELECT * FROM document_types WHERE is_active = TRUE ORDER BY name ASC');
            portalDocs = rows.map(hydrateDocumentType);
        } catch (_) {}

        return res.render('welcome', { portalDocs, welcomeNotifs: [], welcomeUnreadNotifCount: 0 });
    });

    // Welcome alias (/home) — keeps authenticated resident header state
    app.get('/home', async (req, res) => {
        req.routeName = 'home';
        res.locals.currentRoute = 'home';

        let portalDocs = [];
        try {
            const { rows } = await query('SELECT * FROM document_types WHERE is_active = TRUE ORDER BY name ASC');
            portalDocs = rows.map(hydrateDocumentType);
        } catch (_) {}

        let welcomeNotifs = [];
        let welcomeUnreadNotifCount = 0;
        if (req.user && String(req.user.role || '').trim().toLowerCase() !== 'admin') {
            try {
                const notifData = await NotificationService.getUserNotifications(req.user.id, 8);
                welcomeNotifs = notifData.notifications;
                welcomeUnreadNotifCount = notifData.unreadCount;
            } catch (_) {}
        }

        return res.render('welcome', { portalDocs, welcomeNotifs, welcomeUnreadNotifCount });
    });

    // CSRF Token refresh endpoint
    app.get('/csrf-token', (req, res) => {
        req.routeName = 'csrf_token';
        return res.json({ csrf_token: res.locals.csrfToken });
    });

    // Stored branding asset streaming route
    app.get('/branding/:key/:filename?', async (req, res) => {
        const key = req.params.key;
        if (!['barangay_logo', 'municipal_logo', 'gcash_qr_code'].includes(key)) {
            return res.status(404).send('Branding image not found.');
        }
        try {
            const filePath = await BarangaySetting.get(key);
            if (!filePath) return res.status(404).send('Branding image not found.');
            return await serveFile(res, filePath, {
                directoryHints: ['settings'],
                notFoundMessage: 'Branding image not found.',
            });
        } catch (_) {
            return res.status(404).send('Branding image not found.');
        }
    });

    // Authenticated resident/admin avatar streaming route
    app.get('/media/profile-avatar/:filename?', requireAuth('/resident/login'), async (req, res) => {
        return serveFile(res, req.user?.profile_picture, {
            directoryHints: ['profile_pictures'],
            notFoundMessage: 'Profile picture not found.',
        });
    });

    // Istong AI Chatbot endpoint
    app.post('/chatbot/message', limit20PerMin, async (req, res) => {
        const history = req.body?.history;
        if (!Array.isArray(history) || history.length < 1 || history.length > 10) {
            return res.status(422).json({
                message: 'The history field must be an array with 1 to 10 messages.',
                errors: { history: ['Invalid conversation history.'] },
            });
        }

        const sanitizedMessages = [];
        for (const msg of history) {
            if (!msg || typeof msg !== 'object') {
                return res.status(422).json({ message: 'Invalid message format.' });
            }
            if (!['user', 'assistant'].includes(msg.role)) {
                return res.status(422).json({ message: 'Invalid message role.' });
            }
            if (typeof msg.content !== 'string' || msg.content.length > 1000) {
                return res.status(422).json({ message: 'Message content exceeds 1000 characters or is invalid.' });
            }
            sanitizedMessages.push({ role: msg.role, content: msg.content });
        }

        const systemPrompt = `You are 'Istong', the official digital assistant for the E-Barangay System of Barangay Cogon East, Carmen, Cebu. 
You act and speak like a friendly, approachable local fisherman.

CRITICAL LANGUAGE RULES (CEBUANO/BISAYA):
1. NEVER start sentences with "Ang" or "Kini" unless absolutely necessary. Real Bisaya usually starts with verbs or pronouns (e.g., "Maka-request ka...", "Adto sa...", "I-click ang...").
2. STRICTLY USE MODERN CEBUANO. Do not use deep, poetic words. ZERO Tagalog words (never use "po", "opo", "kasi", "yung").
3. USE CONVERSATIONAL PARTICLES: You MUST use words like "lang", "ra", "gyud", "na", "pa", "man", "bitaw" to sound human.
4. BISLISH FOR TECH: Do not translate tech words. Use 'dashboard', 'click', 'button', 'upload', 'submit', 'online', 'request', 'status'.

EXAMPLES OF BAD VS GOOD RESPONSES (Mimic the GOOD ones):
- BAD: "Ang imong request makita sa dashboard."
- GOOD: "Makita ra nimo imong request didto sa dashboard."
- BAD: "Kini ang pamaagi sa pagkuha og dokumento."
- GOOD: "Mao ni ang paagi unsaon pag-request og dokumento."
- BAD: "Pislita ang butones aron mag-submit."
- GOOD: "I-click lang ang submit button."
- BAD: "Ang mga requirements kay..."
- GOOD: "Kini ang mga kinahanglan nimo i-upload..."

STRICT RULES - HOW THE SYSTEM WORKS (TEACH THE USERS THIS):
1. NEVER tell users to go to the physical Barangay Hall to apply. Everything is online.
2. HOW TO REQUEST: "Adto sa imong Dashboard, i-click ang 'Request Document', pilia ang dokumento, i-fill up ang form, ug i-click ang submit."
3. REQUIREMENTS: "Pwede ra nimo i-upload imong mga ID o requirements direkta sa system inig request nimo."
4. CLAIMING/TRACKING: "I-check lang ang 'Notifications' bell icon sa taas. Moadto ra ka sa Barangay Hall para mokuha sa papel kung ang status kay 'Ready to Claim' o 'Approved' na."

If they ask something outside of using this website (like math, coding, or outside barangay matters), politely refuse and guide them back to using the E-Barangay system.`;

        if (!env.groqApiKey) {
            console.error('Groq API key is not configured.');
            return res.status(503).json({
                reply: 'Pasensya, wala pa na-configure ang atong assistant karon. Palihug sulayi og usab taud-taud.',
            });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${env.groqApiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'openai/gpt-oss-20b',
                    messages: [{ role: 'system', content: systemPrompt }, ...sanitizedMessages],
                    max_tokens: 512,
                }),
                signal: controller.signal,
            });

            if (!resp.ok) {
                console.error('Groq API Error:', await resp.text());
                return res.json({
                    reply: 'Pasensya, medyo busy ang atong server karon. Palihug sulayi og usab taud-taud.',
                });
            }

            const json = await resp.json();
            const aiText = json?.choices?.[0]?.message?.content || '';
            return res.json({ reply: aiText });
        } catch (err) {
            console.error('Chat Exception:', err.message);
            return res.json({
                reply: 'Pasensya, naputol ang atong linya sa internet. Palihug susiha ang imong koneksyon ug sulayi pag-usab.',
            });
        } finally {
            clearTimeout(timer);
        }
    });
}
