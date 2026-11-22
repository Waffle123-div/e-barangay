import ejs from 'ejs';
import nodemailer from 'nodemailer';
import path from 'path';
import { env, ROOT_DIR } from '../config/env.js';
import { formatDate } from '../lib/viewHelpers.js';

async function renderEmailView(templateName, locals = {}) {
    const filePath = path.join(ROOT_DIR, 'views', 'emails', `${templateName}.ejs`);
    return ejs.renderFile(filePath, {
        ...locals,
        formatDate,
        currentYear: new Date().getFullYear(),
        route: (name) => {
            if (name === 'resident.login') return `${env.appUrl}/resident/login`;
            return env.appUrl;
        },
    });
}

async function sendViaResend({ to, subject, html, text }) {
    const fromAddr = env.resendFromAddress || 'onboarding@resend.dev';
    const fromName = env.mailFromName || 'E-Barangay Cogon East';
    const payload = {
        from: `${fromName} <${fromAddr}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
    };
    if (text) payload.text = text;
    if (env.mailFromAddress && !env.mailFromAddress.includes('example.com')) {
        payload.reply_to = env.mailFromAddress;
    }

    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Resend API error ${resp.status}: ${body}`);
    }
    return true;
}

async function sendViaMailjet({ to, subject, html, text }) {
    const recipients = (Array.isArray(to) ? to : [to]).map((addr) => ({ Email: addr }));
    const auth = Buffer.from(`${env.mailjetApiKey}:${env.mailjetSecretKey}`).toString('base64');

    const resp = await fetch('https://api.mailjet.com/v3.1/send', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            Messages: [
                {
                    From: {
                        Email: env.mailFromAddress || 'susontroy5@gmail.com',
                        Name: env.mailFromName || 'E-Barangay Cogon East',
                    },
                    To: recipients,
                    Subject: subject,
                    HTMLPart: html,
                    TextPart: text || undefined,
                },
            ],
        }),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.Messages?.[0]?.Status === 'error') {
        throw new Error(`Mailjet error ${resp.status}: ${JSON.stringify(data)}`);
    }
    return true;
}

async function sendViaSmtp({ to, subject, html, text }) {
    const transporter = nodemailer.createTransport({
        host: env.mailHost,
        port: env.mailPort,
        secure: env.mailPort === 465,
        auth: {
            user: env.mailUsername,
            pass: env.mailPassword,
        },
    });

    await transporter.sendMail({
        from: `"${env.mailFromName}" <${env.mailFromAddress}>`,
        to: Array.isArray(to) ? to.join(', ') : to,
        subject,
        html,
        text,
    });
    return true;
}

export async function sendEmail({ to, subject, html, text = '' }) {
    if (!to) return false;

    const preferResend = env.mailMailer.includes('resend') || (!env.mailjetApiKey && env.resendApiKey);
    const preferMailjet = env.mailMailer.includes('mailjet') || (!preferResend && env.mailjetApiKey && env.mailjetSecretKey && env.mailHost.includes('mailjet'));

    if (preferResend && env.resendApiKey) {
        return sendViaResend({ to, subject, html, text });
    }
    if (preferMailjet && env.mailjetApiKey && env.mailjetSecretKey) {
        return sendViaMailjet({ to, subject, html, text });
    }
    if (env.mailHost && env.mailUsername && env.mailPassword) {
        return sendViaSmtp({ to, subject, html, text });
    }
    if (env.resendApiKey) {
        return sendViaResend({ to, subject, html, text });
    }
    if (env.mailjetApiKey && env.mailjetSecretKey) {
        return sendViaMailjet({ to, subject, html, text });
    }

    console.info(`[Mail Dev Fallback] To: ${to} | Subject: ${subject}`);
    return false;
}

export async function sendRegistrationOtpEmail(to, code, name = 'Resident') {
    const html = await renderEmailView('registration_otp', { code, name });
    return sendEmail({
        to,
        subject: `E-Barangay - Your Verification Code (${code})`,
        html,
    });
}

export async function sendResetPasswordCodeEmail(to, code, name = 'Resident') {
    const html = await renderEmailView('reset_password_code', { code, name });
    return sendEmail({
        to,
        subject: 'E-Barangay Account Recovery Code',
        html,
    });
}

export async function sendPasswordChangedEmail(to, name = 'Resident') {
    const html = await renderEmailView('password_changed', { name });
    return sendEmail({
        to,
        subject: 'E-Barangay Password Changed Successfully',
        html,
    });
}

export async function sendAccountApprovedEmail(user) {
    const html = await renderEmailView('account_approved', { user });
    return sendEmail({
        to: user.email,
        subject: 'Your E-Barangay Account is Approved!',
        html,
    });
}

export async function sendAccountRejectedEmail(to, residentName) {
    const html = await renderEmailView('account_rejected', { residentName });
    return sendEmail({
        to,
        subject: 'Action Required: E-Barangay Registration Update',
        html,
    });
}

export async function sendDocumentAcceptedEmail(to, documentRequest) {
    const html = await renderEmailView('document_accepted', { documentRequest });
    return sendEmail({
        to,
        subject: `Your Document Request Is Now Being Processed (#${documentRequest.tracking_number}) - E-Barangay`,
        html,
    });
}

export async function sendDocumentReadyEmail(to, documentRequest) {
    const html = await renderEmailView('document_ready', { documentRequest });
    return sendEmail({
        to,
        subject: 'Your Document is Ready for Pick-up - E-Barangay',
        html,
    });
}

export async function sendDocumentRejectedEmail(to, { trackingNumber, documentType, residentName, purpose = null, reason = null }) {
    const html = await renderEmailView('document_rejected', {
        trackingNumber,
        documentType,
        residentName,
        purpose,
        reason,
    });
    return sendEmail({
        to,
        subject: `Your Document Request Was Rejected (#${trackingNumber}) - E-Barangay`,
        html,
    });
}

export async function sendEmailVerificationLinkEmail(to, verificationUrl) {
    const html = `
<div style="font-family: Arial, sans-serif; background-color: #f8fafc; padding: 30px; color: #1e293b;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 10px; padding: 32px; border: 1px solid #e2e8f0; border-top: 5px solid #1e40af;">
    <h2 style="color: #1e40af; margin-top: 0;">Welcome to Barangay Cogon East!</h2>
    <p>You are receiving this email because an account registration was requested for the E-Barangay Document Request and Tracking System using this email address.</p>
    <p>To securely verify your identity and unlock your Resident Dashboard, please click the button below:</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="${verificationUrl}" style="background-color: #1e40af; color: #ffffff; padding: 12px 26px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Verify Email Address</a>
    </div>
    <p style="font-size: 13px; color: #64748b;">If you did not request this registration, no further action is required and your email remains secure.</p>
    <p style="font-size: 13px; color: #64748b; margin-bottom: 0;">Respectfully,<br><strong>The E-Barangay Administration</strong></p>
  </div>
</div>`;
    return sendEmail({
        to,
        subject: 'Action Required: Verify Your E-Barangay Account',
        html,
    });
}
