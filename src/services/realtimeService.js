import crypto from 'crypto';
import { env } from '../config/env.js';

function deriveTopicHmac(subject) {
    return crypto
        .createHmac('sha256', env.sessionSecret)
        .update(subject)
        .digest('hex')
        .slice(0, 24);
}

export function getAdminChannel() {
    return `admin_${deriveTopicHmac('ebarangay-realtime-admin')}`;
}

export function getResidentChannel(userId) {
    return `resident_${Number(userId)}_${deriveTopicHmac(`ebarangay-realtime-resident-${Number(userId)}`)}`;
}

export function getClientRealtimeConfig(user) {
    if (!user || !env.supabaseUrl || !env.supabaseAnonKey) {
        return null;
    }
    const roleLower = String(user.role || '').trim().toLowerCase();
    const isAdmin = roleLower === 'admin';
    return {
        url: env.supabaseUrl,
        anonKey: env.supabaseAnonKey,
        channel: isAdmin ? getAdminChannel() : getResidentChannel(user.id),
        role: isAdmin ? 'admin' : 'resident',
        userId: Number(user.id),
    };
}

async function sendBroadcastToTopics(messages) {
    if (!env.supabaseUrl || !env.supabaseServiceRoleKey || messages.length === 0) {
        return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
        const resp = await fetch(`${env.supabaseUrl}/realtime/v1/api/broadcast`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: env.supabaseServiceRoleKey,
                Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
            },
            body: JSON.stringify({ messages }),
            signal: controller.signal,
        });
        return resp.ok;
    } catch (err) {
        console.debug('[realtimeService.broadcast skipped]', err.message);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export async function broadcastRealtimeEvent(event, data = {}) {
    const payload = {
        event,
        data,
        timestamp: new Date().toISOString(),
    };

    const messages = [
        {
            topic: getAdminChannel(),
            event: 'ebarangay_event',
            payload,
        },
    ];

    if (event === 'request.status_changed' && data?.user_id !== undefined && data?.user_id !== null) {
        messages.push({
            topic: getResidentChannel(data.user_id),
            event: 'ebarangay_event',
            payload,
        });
    }

    return sendBroadcastToTopics(messages);
}
