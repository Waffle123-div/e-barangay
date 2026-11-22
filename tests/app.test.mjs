process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.GROQ_API_KEY;

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ROOT_DIR } from '../src/config/env.js';
import { hashSecret, verifySecret } from '../src/lib/password.js';
import { route, routeIs } from '../src/lib/routeMap.js';

const app = createApp();

test('static assets are served with 200 OK', async () => {
    for (const assetPath of ['/css/style.css', '/css/ebarangay-theme.css', '/js/app.js', '/images/logo.png']) {
        const res = await request(app).get(assetPath);
        assert.equal(res.status, 200, `Expected 200 for ${assetPath}, got ${res.status}`);
    }
});

test('public and auth GET routes render 200 with expected content and security headers', async () => {
    const welcome = await request(app).get('/');
    assert.equal(welcome.status, 200);
    assert.ok(welcome.text.includes('E-Barangay'), 'Welcome page should include E-Barangay');
    assert.equal(welcome.headers['x-content-type-options'], 'nosniff');
    assert.equal(welcome.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(welcome.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.ok(welcome.headers['permissions-policy'], 'Permissions-Policy header should be present');

    const home = await request(app).get('/home');
    assert.equal(home.status, 200);

    const csrf = await request(app).get('/csrf-token');
    assert.equal(csrf.status, 200);
    assert.ok(typeof csrf.body.csrf_token === 'string' && csrf.body.csrf_token.length >= 32);

    for (const page of [
        { url: '/admin/login', marker: 'Admin' },
        { url: '/resident/login', marker: 'Resident' },
        { url: '/resident/register', marker: 'Register' },
        { url: '/resident/forgot-password', marker: 'Forgot' },
        { url: '/resident/pending-approval', marker: 'Pending' },
    ]) {
        const res = await request(app).get(page.url);
        assert.equal(res.status, 200, `Expected 200 for ${page.url}, got ${res.status}`);
        assert.ok(res.text.toLowerCase().includes(page.marker.toLowerCase()), `${page.url} missing "${page.marker}"`);
    }
});

test('protected admin and resident routes redirect unauthenticated users', async () => {
    for (const p of ['/admin', '/admin/requests', '/admin/users']) {
        const res = await request(app).get(p);
        assert.equal(res.status, 302, `Expected 302 for ${p}`);
        assert.equal(res.headers.location, '/admin/login');
    }

    for (const p of ['/resident', '/resident/settings', '/resident/request-document']) {
        const res = await request(app).get(p);
        assert.equal(res.status, 302, `Expected 302 for ${p}`);
        assert.equal(res.headers.location, '/resident/login');
    }
});

test('CSRF enforcement and chatbot validation work correctly', async () => {
    // Missing CSRF token -> 403 or 419
    const noCsrfJson = await request(app)
        .post('/chatbot/message')
        .set('Accept', 'application/json')
        .send({ history: [{ role: 'user', content: 'Hello' }] });
    assert.equal(noCsrfJson.status, 419);

    const noCsrfForm = await request(app)
        .post('/chatbot/message')
        .send({ history: [{ role: 'user', content: 'Hello' }] });
    assert.equal(noCsrfForm.status, 403);

    // Cookie-backed agent round-trip with valid CSRF token
    const agent = request.agent(app);
    const tokRes = await agent.get('/csrf-token');
    assert.equal(tokRes.status, 200);
    const token = tokRes.body.csrf_token;

    // Empty / invalid history -> 422
    const invalidPayload = await agent
        .post('/chatbot/message')
        .set('Accept', 'application/json')
        .set('x-csrf-token', token)
        .send({ history: [] });
    assert.equal(invalidPayload.status, 422);

    // Valid history with missing GROQ_API_KEY -> 503
    const validOffline = await agent
        .post('/chatbot/message')
        .set('Accept', 'application/json')
        .set('x-csrf-token', token)
        .send({ history: [{ role: 'user', content: 'Unsaon pagkuha og Barangay Clearance?' }] });
    assert.equal(validOffline.status, 503);
});

test('password hashing supports new hashes and Laravel $2y$ prefixes', async () => {
    const hash = await hashSecret('MySecretPin123!');
    assert.ok(await verifySecret('MySecretPin123!', hash));
    assert.equal(await verifySecret('WrongSecret', hash), false);

    // Simulate a Laravel $2y$12$ bcrypt hash
    const laravelPrefixed = hash.replace(/^\$2[ab]\$/, '$2y$');
    assert.ok(await verifySecret('MySecretPin123!', laravelPrefixed));

    // Seeded demo hashes in supabase/schema.sql
    assert.ok(await verifySecret('admin123', '$2a$12$5LTNT2TsQSRM63npq32CROUSLTv8KqUpYcsnslO8LVHPIkmfUp5Rq'));
    assert.ok(await verifySecret('password', '$2a$12$WOem1FJ.mRbw20bDpGXaxeUPLTZbv2eI0RPW5rmgdIA54gF4SkmLa'));
});

test('routeMap resolves positional and query parameters cleanly', () => {
    const url = route('admin.requests.generate', { 0: 42, doc_type: 'Barangay Clearance' });
    assert.equal(url, '/admin/requests/generate/42?doc_type=Barangay%20Clearance');
    assert.equal(routeIs('admin.requests.show', 'admin.requests.*'), true);
    assert.equal(routeIs('resident.dashboard', 'admin.*'), false);
});

test('supabase/schema.sql defines all 10 tables and 15 document types', () => {
    const sql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'schema.sql'), 'utf8');
    const expectedTables = [
        'users',
        'document_types',
        'document_requests',
        'community_concerns',
        'community_concern_remarks',
        'activity_logs',
        'barangay_settings',
        'notifications',
        'password_reset_tokens',
        'sessions',
    ];
    for (const tbl of expectedTables) {
        assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}\\b`), `Missing table ${tbl}`);
    }

    const docTypeSeedBlock = sql.match(/INSERT INTO document_types[\s\S]*?ON CONFLICT \(name\) DO NOTHING;/);
    assert.ok(docTypeSeedBlock, 'Missing document_types seed INSERT block');
    const rowCount = (docTypeSeedBlock[0].match(/\.docx'/g) || []).length;
    assert.equal(rowCount, 15, `Expected 15 document_types rows with .docx templates, found ${rowCount}`);
});
