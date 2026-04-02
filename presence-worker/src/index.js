import { DurableObject } from 'cloudflare:workers';

const APP_ORIGIN = 'https://oref-map.org';
const VISITOR_OBJECT_NAME = 'global-presence';
const ACTIVE_WINDOW_MS = 60 * 60 * 1000;
const RETENTION_WINDOW_MS = 65 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const BOT_UA_RE = /bot|crawler|spider|slurp|preview|facebookexternalhit|whatsapp|telegrambot|discordbot|bingpreview|embedly|quora link preview|google web preview|skypeuripreview|headless/i;

function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': APP_ORIGIN,
    'Access-Control-Expose-Headers': 'X-Served-By',
    ...extra,
  };
}

function jsonResponse(data, init) {
  return new Response(JSON.stringify(data), {
    status: init?.status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Served-By': 'presence-worker',
      ...corsHeaders(init?.headers),
    },
  });
}

function isLikelyBot(userAgent) {
  return BOT_UA_RE.test(userAgent || '');
}

async function handlePresence(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: corsHeaders({
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      }),
    });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, {
      status: 405,
      headers: { 'Allow': 'POST, OPTIONS' },
    });
  }

  const payload = await request.json().catch(() => null);
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId || sessionId.length > 128) {
    return jsonResponse({ error: 'Invalid sessionId' }, { status: 400 });
  }

  const id = env.VISITOR_COUNTER.idFromName(VISITOR_OBJECT_NAME);
  const stub = env.VISITOR_COUNTER.get(id, { locationHint: 'me' });
  const bot = isLikelyBot(request.headers.get('User-Agent'));
  const doResponse = await stub.fetch('https://visitor-counter.internal/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Is-Bot': bot ? '1' : '0',
    },
    body: JSON.stringify({ sessionId }),
  });

  return new Response(await doResponse.text(), {
    status: doResponse.status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Served-By': 'presence-worker',
    }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/presence') {
      return new Response('Not found', {
        status: 404,
        headers: corsHeaders(),
      });
    }
    return handlePresence(request, env);
  },
};

export class VisitorCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.lastPruneAt = 0;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
    `);
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
    }

    const payload = await request.json().catch(() => null);
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 128) {
      return jsonResponse({ error: 'Invalid sessionId' }, { status: 400 });
    }

    const now = Date.now();
    const activeAfter = now - ACTIVE_WINDOW_MS;
    const pruneBefore = now - RETENTION_WINDOW_MS;

    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.sql.exec('DELETE FROM sessions WHERE last_seen < ?', pruneBefore);
      this.lastPruneAt = now;
    }

    if (request.headers.get('X-Is-Bot') !== '1') {
      this.sql.exec(
        `INSERT INTO sessions (session_id, last_seen)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen`,
        sessionId,
        now,
      );
    }

    const cursor = this.sql.exec(
      'SELECT COUNT(*) AS count FROM sessions WHERE last_seen >= ?',
      activeAfter,
    );
    const row = cursor.next();
    const count = row.done ? 0 : Number(row.value.count) || 0;

    return jsonResponse({ count });
  }
}
