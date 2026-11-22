# Deployment Guide — E-Barangay Portal (Node.js + Supabase + Vercel)

This application (`c:\xampp\htdocs\e_barangay_vercel`) is the Node.js (ESM) + Express 4 + EJS remake of the E-Barangay Document Request & Tracking System, designed specifically for **Supabase** (PostgreSQL, Private Storage, Realtime Broadcast) and **Vercel** Serverless Functions while keeping the original routes, workflows, and UI/UX intact.

---

## Architecture Overview

| Layer | Implementation |
| --- | --- |
| Runtime & Web Framework | Node.js `>=20`, Express `4.21`, EJS templates |
| Serverless Entry | `api/index.js` exporting Express `app` (`vercel.json` routes all requests there; `public/**` served as static assets) |
| Database & Sessions | Supabase PostgreSQL (`pg` pool) + custom PostgreSQL Express session store (`sessions` table; falls back to `MemoryStore` only when `DATABASE_URL` is unset locally) |
| File & Document Storage | Private Supabase Storage bucket (`ebarangay-files`), proxied only after session + ownership/admin checks |
| Real-Time Updates | Supabase Realtime Broadcast REST API + browser `@supabase/supabase-js@2` client (replaces `websocket-server.js`) |
| Word & ZIP Export | In-memory `pizzip` + `docxtemplater` + `docx` Buffer generation (`templates/*.docx` & `templates/document_templates/*.docx`) |

---

## Step 1: Set Up Supabase (Database & Private Storage)

1. Create a Supabase project (choose a nearby region such as `ap-southeast-1` Singapore).
2. Open **SQL Editor** in the Supabase Dashboard, paste the full contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
   - Alternatively, from a local terminal after setting `DATABASE_URL` in `.env`, run:
     ```bash
     npm run db:setup
     ```
   - This idempotently creates all 10 tables (`users`, `document_types`, `document_requests`, `community_concerns`, `community_concern_remarks`, `activity_logs`, `barangay_settings`, `notifications`, `password_reset_tokens`, `sessions`), indexes, default `barangay_settings`, 15 official `document_types`, and 2 demo users.
3. Verify the **private** Storage bucket:
   - Go to **Storage -> Buckets** and confirm `ebarangay-files` exists with **Public = OFF (Private)**.
   - All resident IDs, selfies, proof of residency, concern photos, branding images, and custom `.docx` templates are uploaded into this private bucket and streamed through authenticated backend proxy routes.
4. Copy your credentials from **Project Settings**:
   - **Database -> Connection string -> Transaction pooler** (port `6543`, append `?pgbouncer=true`) -> `DATABASE_URL`.
   - **API -> Project URL** -> `SUPABASE_URL`.
   - **API -> anon public key** -> `SUPABASE_ANON_KEY`.
   - **API -> service_role key** (keep server-side only!) -> `SUPABASE_SERVICE_ROLE_KEY`.

---

## Step 2: Configure Environment Variables on Vercel

Import the `e_barangay_vercel` project into Vercel (or deploy with Vercel CLI) and add these Environment Variables in **Project Settings -> Environment Variables**:

### Core, Database, Storage & Realtime (Required for Production)

| Variable | Description |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_NAME` | `E-Barangay` |
| `APP_URL` | Your production URL, e.g. `https://your-app.vercel.app` (no trailing slash) |
| `SESSION_SECRET` | Long random secret string (e.g. `openssl rand -hex 32`) |
| `SESSION_LIFETIME` | Session idle timeout in minutes (default `120`) |
| `DATABASE_URL` | Supabase PostgreSQL **Transaction Pooler** URL (port `6543`, `?pgbouncer=true`) |
| `SUPABASE_URL` | Supabase Project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | Supabase `anon` key (used in browser Realtime subscription) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` key (server-side Storage + Realtime broadcast) |
| `SUPABASE_STORAGE_BUCKET` | `ebarangay-files` |

### OAuth, Email, SMS, reCAPTCHA & Chatbot (As Needed)

| Variable | Description |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret |
| `GOOGLE_REDIRECT_URL` | `https://your-app.vercel.app/auth/google/callback` (also add this URI in Google Cloud Console) |
| `MAIL_MAILER` | `resend_http`, `mailjet_http`, `smtp`, or `log` |
| `MAIL_FROM_ADDRESS` | Verified sender email address |
| `MAIL_FROM_NAME` | Sender display name (e.g. `E-Barangay Cogon East`) |
| `RESEND_API_KEY` / `RESEND_FROM_ADDRESS` | Required if `MAIL_MAILER=resend_http` |
| `MAILJET_API_KEY` / `MAILJET_SECRET_KEY` | Required if `MAIL_MAILER=mailjet_http` |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_USERNAME` / `MAIL_PASSWORD` | Required if `MAIL_MAILER=smtp` |
| `TEXTBEE_API_KEY` / `TEXTBEE_DEVICE_ID` | Textbee SMS gateway credentials for OTP and status SMS alerts |
| `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY` | Google reCAPTCHA v2 keys for login/registration protection |
| `GROQ_API_KEY` | Groq API key powering the "Istong" Fisherman Assistant (`/chatbot/message`) |

---

## Step 3: Local Development & Verification

```bash
npm install
cp .env.example .env   # Fill in local/Supabase credentials
npm run dev            # Runs Express on http://localhost:3000 with --watch
```

Verification scripts included in the repository:

```bash
npm run verify:views   # Compiles and smoke-renders all 42 EJS templates
npm run verify:word    # Tests .docx placeholder substitution, fallback, and .zip bundling
npm test               # Runs integration & unit tests via node:test + supertest
```

---

## Operational Notes

- **Vercel 4.5 MB Payload Limit:** Vercel Serverless Functions cap incoming HTTP request bodies at **4.5 MB**. Keep individual uploaded documents, IDs, selfies, and logos under ~4 MB per request.
- **Seeded Demo Credentials:** `supabase/schema.sql` seeds `admin@example.com` / `admin123` and `resident@example.com` / `password`. Change both passwords immediately in any shared or production environment.
- **Session Persistence:** Ensure `sessions` exists in Supabase (`supabase/schema.sql` creates it automatically) and `SESSION_SECRET` is identical across deployments so authenticated cookies stay valid.
