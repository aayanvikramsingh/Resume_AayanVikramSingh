/**
 * resume-stats — private analytics collector for the resume landing page.
 *
 *   POST /hit     records one event. Called by the public page, no auth.
 *   GET  /stats   returns aggregates. Requires the STATS_PASSWORD secret.
 *
 * Each event is stored as a KV key whose payload lives in the key's *metadata*,
 * so /stats can rebuild everything from list() calls alone. No per-key reads is
 * what keeps a dashboard load at a couple of operations instead of hundreds.
 */

const SITE_ORIGIN = 'https://aayanvikramsingh.github.io';
const RETAIN_DAYS = 400;

// Localhost is allowed alongside the live site so the dashboard can be opened
// from a local preview server. This only decides which pages may *read* a
// response — /stats still demands the password, and /hit is public anyway.
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Anything not on this list is rejected, so a stranger poking at /hit can't
// invent event names and clutter the dashboard.
const EVENTS = new Set([
  'view',
  'read-resume',
  'open-drive',
  'linkedin',
  'github',
  'email',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return withCors(request, new Response(null, { status: 204 }));
    }
    if (url.pathname === '/hit' && request.method === 'POST') {
      return withCors(request, await recordHit(request, env));
    }
    if (url.pathname === '/stats' && request.method === 'GET') {
      return withCors(request, await readStats(request, env));
    }
    return withCors(request, new Response('not found', { status: 404 }));
  },
};

function withCors(request, response) {
  const origin = request.headers.get('Origin') || '';
  const allow = origin === SITE_ORIGIN || DEV_ORIGIN.test(origin) ? origin : SITE_ORIGIN;

  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', allow);
  r.headers.set('Vary', 'Origin');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  r.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  r.headers.set('Access-Control-Max-Age', '86400');
  return r;
}

/* ------------------------------------------------------------------ write */

async function recordHit(request, env) {
  // The page sends text/plain rather than application/json: it lets sendBeacon
  // fire without a CORS preflight, which a beacon cannot perform.
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return new Response('bad payload', { status: 400 });
  }

  const event = String(payload.event || '');
  if (!EVENTS.has(event)) return new Response('unknown event', { status: 400 });

  const cf = request.cf || {};
  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  const metadata = {
    e: event,
    t: now.toISOString(),
    v: await visitorId(request, day),
    r: refHost(payload.ref),
    s: clip(payload.utm_source, 32),
    m: clip(payload.utm_medium, 32),
    c: clip(payload.utm_campaign, 32),
    co: cf.country || '',
    ci: cf.city || '',
    d: deviceOf(request.headers.get('User-Agent') || ''),
  };

  const key = `h:${day}:${now.getTime()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.HITS.put(key, '', { metadata, expirationTtl: RETAIN_DAYS * 86400 });

  return new Response(null, { status: 204 });
}

/**
 * A per-day fingerprint used only to tell repeat loads apart from new people.
 * The day is part of the hash, so the value rotates every midnight UTC and the
 * same visitor cannot be followed from one day to the next. Nothing here can be
 * reversed into an IP, and no raw IP is ever written to storage.
 */
async function visitorId(request, day) {
  const raw = [
    request.headers.get('CF-Connecting-IP') || '',
    request.headers.get('User-Agent') || '',
    day,
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function refHost(ref) {
  if (!ref) return '';
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    // Navigations within the site aren't referrals worth counting.
    return host === new URL(SITE_ORIGIN).hostname ? '' : host;
  } catch {
    return '';
  }
}

function deviceOf(ua) {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/* ------------------------------------------------------------------- read */

async function readStats(request, env) {
  const supplied = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.STATS_PASSWORD || !safeEqual(supplied, env.STATS_PASSWORD)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const hits = [];
  let cursor;
  do {
    const page = await env.HITS.list({ prefix: 'h:', limit: 1000, cursor });
    for (const k of page.keys) if (k.metadata) hits.push(k.metadata);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const byDay = new Map();
  const events = {};
  const referrers = {};
  const sources = {};
  const countries = {};
  const cities = {};
  const devices = {};
  const visitors = new Set();

  for (const h of hits) {
    events[h.e] = (events[h.e] || 0) + 1;

    // Breakdowns describe *people arriving*, so they're keyed off page views.
    // Counting them per click would double-weight whoever clicks several links.
    if (h.e !== 'view') continue;

    const day = (h.t || '').slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { views: 0, visitors: new Set() });
    const bucket = byDay.get(day);
    bucket.views += 1;
    if (h.v) {
      bucket.visitors.add(h.v);
      visitors.add(h.v);
    }

    bump(referrers, h.r || 'direct / unknown');
    bump(sources, h.s || '(untagged)');
    bump(countries, h.co || 'unknown');
    bump(cities, h.ci || 'unknown');
    bump(devices, h.d || 'unknown');
  }

  const views = events.view || 0;
  const drive = (events['read-resume'] || 0) + (events['open-drive'] || 0);

  return json({
    generated: new Date().toISOString(),
    totals: {
      views,
      visitors: visitors.size,
      resumeOpens: drive,
      // Share of visits that ended in the resume actually being opened.
      clickThrough: views ? Math.round((drive / views) * 1000) / 10 : 0,
    },
    events,
    timeline: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, b]) => ({ day, views: b.views, visitors: b.visitors.size })),
    referrers: rank(referrers),
    sources: rank(sources),
    countries: rank(countries),
    cities: rank(cities),
    devices: rank(devices),
  });
}

function bump(table, key) {
  table[key] = (table[key] || 0) + 1;
}

function rank(table) {
  return Object.entries(table)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Compares in constant time so a wrong password can't be found byte by byte. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
