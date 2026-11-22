import ejs from 'ejs';
import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '../src/config/env.js';

const VIEWS_DIR = path.join(ROOT_DIR, 'views');

function walkEjs(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkEjs(full));
        else if (entry.name.endsWith('.ejs')) out.push(full);
    }
    return out;
}

const mockUser = {
    id: 2,
    user_id: 'USR-00002',
    name: 'JUAN DELA CRUZ',
    first_name: 'JUAN',
    middle_name: 'SANTOS',
    last_name: 'DELA CRUZ',
    suffix: '',
    username: 'juandc',
    email: 'resident@example.com',
    phone_number: '09171234567',
    contact_number: '09171234567',
    role: 'Resident',
    status: 'active',
    birthdate: '1995-05-05',
    age: 31,
    birthplace: 'CEBU CITY',
    gender: 'Male',
    civil_status: 'Single',
    nationality: 'Filipino',
    occupation: 'Fisherman',
    purok: 'Purok 1',
    sitio: 'Sitio Ilaya',
    house_number: '12',
    street: 'Rizal St',
    barangay_address: 'Cogon East',
    municipality: 'Carmen',
    province: 'Cebu',
    zip_code: '6005',
    id_type: 'National ID',
    id_photo: 'valid_ids/sample.jpg',
    id_expiry_date: new Date('2029-12-31'),
    id_verified_at: new Date(),
    id_uploaded_at: new Date(),
    proof_of_residency: 'residency_proofs/sample.jpg',
    selfie_photo: 'selfies/sample.jpg',
    face_verified_at: new Date(),
    profile_picture: 'profile_pictures/sample.jpg',
    profile_picture_url: '/media/profile-avatar/sample.jpg',
    id_document_url: '/admin/resident-id-document/2/sample.jpg',
    selfie_photo_url: '/admin/resident-selfie/sample.jpg',
    formatted_address: '12, Rizal St, Cogon East, Carmen, Cebu, 6005',
    email_verified_at: new Date(),
    has_verified_email: true,
    two_factor_enabled: false,
    google_id: null,
    created_at: new Date(),
};

const mockDocType = {
    id: 1,
    name: 'Barangay Clearance',
    description: 'General clearance',
    fee: 50,
    formatted_fee: '₱50.00',
    processing_days: '1-2 Business Days',
    requirements: ['Valid ID'],
    requirements_list: ['Valid ID'],
    template_file: 'document_templates/01_Barangay_Clearance_General.docx',
    is_active: true,
    icon: 'fa-file-shield',
};

const mockDocReq = {
    id: 10,
    user_id: 2,
    tracking_number: 'REQ-2026-00001',
    first_name: 'JUAN',
    middle_initial: 'S',
    last_name: 'DELA CRUZ',
    resident_name: 'JUAN S. DELA CRUZ',
    contact_number: '09171234567',
    resident_email: 'resident@example.com',
    purok: 'Purok 1',
    street: 'Rizal St',
    city: 'COGON EAST, CARMEN, CEBU',
    age: '31',
    document_type_id: 1,
    document_type: 'Barangay Clearance',
    id_type: 'National ID',
    resolved_id_type: 'National ID',
    documents: [{ type: 'Barangay Clearance', purpose: 'EMPLOYMENT', fee: 50, is_generated: false }],
    documents_list: [{ type: 'Barangay Clearance', purpose: 'EMPLOYMENT', fee: 50, is_generated: false }],
    attachments_list: [{ file_path: 'attachments/id.jpg', file_name: 'id.jpg', doc_type: 'Valid ID', file_type: 'image', file_size: 1024 }],
    priority: 'Normal',
    purpose: 'EMPLOYMENT',
    fee: 50,
    status: 'Pending',
    is_generated: false,
    user: mockUser,
    created_at: new Date(),
    updated_at: new Date(),
    hasMultipleDocuments: () => false,
};

const mockConcern = {
    id: 5,
    concern_id: 'CON-2026-00001',
    user_id: 2,
    resident_name: 'JUAN DELA CRUZ',
    resident_email: 'resident@example.com',
    contact_number: '09171234567',
    address: 'Cogon East',
    title: 'Broken Streetlight',
    category: 'Street Lighting',
    description: 'Lamp post is flickering',
    location: 'Purok 2',
    incident_date: new Date(),
    photo_path: 'concerns/photo.jpg',
    status: 'Pending',
    admin_remarks: 'Noted',
    user: mockUser,
    updated_by_admin: mockUser,
    remarks: [{ id: 1, remark: 'Investigating', attachment_path: 'community-concern-feedback/img.jpg', admin: mockUser, created_at: new Date() }],
    created_at: new Date(),
};

const mockLog = {
    id: 1,
    user_id: 2,
    action: 'request_accepted',
    description: 'Accepted #REQ-2026-00001',
    ip_address: '127.0.0.1',
    user_agent: 'Mozilla/5.0',
    user: mockUser,
    linked_request_id: 10,
    created_at: new Date(),
};

const mockLocals = {
    body: '<div>Mock Body</div>',
    pageTitle: 'Test Page',
    currentRoute: 'admin.dashboard',
    authUser: mockUser,
    user: mockUser,
    isAuthenticated: true,
    isAdmin: true,
    isResident: true,
    csrfToken: 'mock-csrf-token',
    csrf_token: () => 'mock-csrf-token',
    csrf_field: () => '<input type="hidden" name="_token" value="mock-csrf-token">',
    method_field: (m) => `<input type="hidden" name="_method" value="${m}">`,
    route: (name) => `/mock/${name}`,
    routeIs: () => false,
    asset: (p) => `/${p}`,
    versionedAsset: (p) => `/${p}?v=1`,
    settingImageUrl: (k, p) => p ? `/branding/${k}/logo.png` : null,
    config: () => 'mock-site-key',
    request: () => '',
    requestInput: () => '',
    requestFilled: () => false,
    requestHas: () => false,
    fullUrlWithQuery: () => '/mock?q=1',
    formatDate: () => 'Nov 22, 2026',
    diffForHumans: () => '1 minute ago',
    diffInHours: () => 12,
    isPast: () => false,
    calcAge: () => 31,
    numberFormat: (n) => Number(n || 0).toFixed(2),
    md5: () => 'abc123',
    e: (s) => String(s ?? ''),
    nl2br: (s) => String(s ?? ''),
    ucwords: (s) => String(s ?? ''),
    ucfirst: (s) => String(s ?? ''),
    strLimit: (s) => String(s ?? ''),
    STR_PAD_LEFT: 'left',
    STR_PAD_RIGHT: 'right',
    STR_PAD_BOTH: 'both',
    str_pad: (input, len, pad = ' ', type = 'right') => {
        const s = String(input ?? '');
        return type === 'left' ? s.padStart(len, pad) : s.padEnd(len, pad);
    },
    phpSubstr: (str, start, len) => {
        const s = String(str ?? '');
        const st = start < 0 ? Math.max(0, s.length + start) : start;
        return len === undefined ? s.slice(st) : s.slice(st, st + len);
    },
    phpTrim: (str) => String(str ?? '').trim(),
    collect: (v = []) => (Array.isArray(v) ? v : []),
    strip_tags: (s) => String(s ?? '').replace(/<[^>]*>/g, ''),
    url: (p = '') => (/^https?:\/\//i.test(String(p ?? '')) ? String(p ?? '') : '/' + String(p ?? '').replace(/^\/+/, '')),
    is_null: (v) => v === null || v === undefined,
    round: (v, p = 0) => {
        const f = Math.pow(10, Number(p) || 0);
        return Math.round((Number(v) || 0) * f) / f;
    },
    addslashes: (s) => String(s ?? ''),
    basename: (s) => String(s ?? '').split('/').pop(),
    isValidUrl: (s) => /^https?:\/\//i.test(String(s || '')),
    todayIso: '2026-11-22',
    tomorrowIso: '2026-11-23',
    currentYear: 2026,
    renderPagination: () => '',
    sessionGet: () => null,
    sessionHas: () => false,
    old: (k, d = '') => d,
    errors: { all: () => [], any: () => false, has: () => false, first: () => null, bag: {} },
    flash: {},
    appEnvLabel: 'PRODUCTION',
    appVersionLabel: 'v2.0 (Node.js)',
    runtimeVersionLabel: 'Node v24.13.0',
    // Domain data
    portalDocs: [mockDocType],
    welcomeNotifs: [],
    welcomeUnreadNotifCount: 0,
    pendingRequestsCount: 1,
    pendingApprovalsCount: 1,
    pendingConcernsCount: 1,
    logoUrl: '/images/logo.png',
    realtimeConfig: null,
    residentActiveRequestsCount: 1,
    unreadNotifCount: 0,
    userNotifs: [{ id: '1', data: { document_type: 'Barangay Clearance', tracking_number: 'REQ-1', message: 'Ready', status: 'Ready' }, read_at: null, created_at: new Date() }],
    totalRequests: 5,
    pendingReviews: 1,
    approvedToday: 2,
    overdueRequests: 0,
    activeRequestsCount: 3,
    avgProcessing: 1.5,
    activeUsers: 10,
    recentRequests: [mockDocReq],
    allRequests: [mockDocReq],
    paginator: { currentPage: 1, lastPage: 1, total: 1, firstItem: 1, lastItem: 1, baseUrl: '/mock', query: {} },
    currentDocType: 'All',
    currentStatus: 'Pending_Review',
    quickFilter: 'all',
    tabCounts: { Pending_Review: 1, Processing: 0, Ready: 0, Completed: 0, Rejected: 0, All: 1, Resident: 1, Admin: 1, Pending: 0, pending_approval: 1, active: 1, rejected: 0 },
    validTypes: ['Barangay Clearance'],
    activeDocTypes: [mockDocType],
    docTypesList: [mockDocType],
    residents: [mockUser],
    pendingUsers: [mockUser],
    totalUsers: 10,
    newRegistrations: 2,
    adminUsers: 1,
    allUsers: [mockUser],
    currentRole: 'All',
    currentSort: 'newest',
    logs: [mockLog],
    actionTypes: ['request_accepted'],
    concerns: [mockConcern],
    statusCounts: { All: 1, Pending: 1, 'Under Review': 0, 'In Progress': 0, Resolved: 0, Rejected: 0 },
    concernStatuses: ['Pending', 'Under Review', 'In Progress', 'Resolved', 'Rejected'],
    documentTypes: [mockDocType],
    stats: { total: 1, active: 1, inactive: 0, paid: 1, free: 0 },
    availableTemplates: ['01_Barangay_Clearance_General.docx'],
    settings: { barangay_name: 'Barangay Cogon East', municipality: 'Carmen', province: 'Cebu', barangay_logo: '', municipal_logo: '', gcash_qr_code: '' },
    pendingCount: 1,
    approvedCount: 2,
    totalCount: 3,
    firstName: 'JUAN',
    isNewUser: false,
    announcement: { type: 'info', category: 'Advisory', title: 'Notice', message: 'Test', action_url: '', action_text: 'Learn More', is_dismissible: true, updated_at: new Date() },
    latestRequest: mockDocReq,
    currentStep: 1,
    myRequest: mockDocReq,
    currentLastUpdate: '',
    currentTotalCount: 1,
    docRequest: mockDocReq,
    receiptNumber: 'REC-2026-00001',
    feeAmount: 50,
    categories: ['Infrastructure & Roads', 'Others'],
    residentAddress: 'Purok 1, Cogon East',
    sessions: [{ id: 's1', is_current: true, device: 'Desktop', browser: 'Chrome', ip_address: '127.0.0.1', last_active_at: new Date() }],
    activityLogs: [mockLog],
    activeTab: 'profile',
    email: 'resident@example.com',
    verified_email: 'resident@example.com',
    identifier: 'resident@example.com',
    phone: '09171234567',
    code: '12345',
    name: 'JUAN',
    residentName: 'JUAN',
    trackingNumber: 'REQ-2026-00001',
    documentType: 'Barangay Clearance',
    purpose: 'EMPLOYMENT',
    reason: 'Blurry ID',
    documentRequest: mockDocReq,
};

const files = walkEjs(VIEWS_DIR);
console.log(`Found ${files.length} EJS templates.`);

let compileFailures = 0;
let renderFailures = 0;
let leftoverIssues = 0;

for (const file of files) {
    const rel = path.relative(VIEWS_DIR, file);
    const content = fs.readFileSync(file, 'utf8');

    // Check leftover Blade tokens
    const badTokens = [];
    const strippedComments = content.replace(/<%#[\s\S]*?%>/g, '');
    if (/@(if|elseif|else|endif|foreach|endforeach|forelse|endforelse|for|endfor|php|endphp|csrf|method|json|include|extends|section|endsection|yield|error|enderror)\b/.test(strippedComments)) {
        badTokens.push('leftover @blade directive');
    }
    if (/\{\{\s*[^}]*\}\}/.test(strippedComments) || /\{!!/.test(strippedComments)) {
        badTokens.push('leftover {{ }} or {!! !!}');
    }
    if (/\\App\\|Carbon::|\$__env|->links\(/.test(strippedComments)) {
        badTokens.push('leftover PHP class/method');
    }
    if (badTokens.length > 0) {
        leftoverIssues++;
        console.error(`[BLADE_ARTIFACT] ${rel}: ${badTokens.join(', ')}`);
    }

    // Compile & Smoke Render
    try {
        const fn = ejs.compile(content, { filename: file, root: VIEWS_DIR });
        try {
            fn({ ...mockLocals });
        } catch (renderErr) {
            renderFailures++;
            console.error(`[RENDER_ERROR] ${rel}: ${renderErr.message}`);
        }
    } catch (compileErr) {
        compileFailures++;
        console.error(`[COMPILE_ERROR] ${rel}: ${compileErr.message}`);
    }
}

console.log(`Summary: total=${files.length}, compileFailures=${compileFailures}, renderFailures=${renderFailures}, leftoverIssues=${leftoverIssues}`);
if (compileFailures > 0 || renderFailures > 0 || leftoverIssues > 0) {
    process.exit(1);
}
