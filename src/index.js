// ===== Toffee Live m3u8 header-bypass proxy (Cloudflare Worker) =====

const UPSTREAM_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'referer': 'https://toffeelive.com/',
  'origin': 'https://toffeelive.com',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
};

const CDN = 'https://prod-linear-media.toffeelive.com/cdn/live/';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const self = new URL(request.url);

    // দুইভাবে ব্যবহার করা যাবে:
    //   /?url=<full m3u8 url with token>
    //   /?ch=somoy_tv&token=<edge-cache-token>
    let target = self.searchParams.get('url');
    if (!target) {
      const ch = self.searchParams.get('ch');
      const token = self.searchParams.get('token');
      if (ch && token) target = `${CDN}${ch}/playlist.m3u8?edge-cache-token=${token}`;
    }
    if (!target) {
      return new Response('Usage: /?url=<m3u8 url>  or  /?ch=somoy_tv&token=<edge-cache-token>', { headers: CORS });
    }

    const headers = new Headers(UPSTREAM_HEADERS);
    const range = request.headers.get('range');
    if (range) headers.set('range', range);

    let upstream;
    try {
      upstream = await fetch(target, { headers, redirect: 'follow' });
    } catch (e) {
      return new Response('Upstream error: ' + e.message, { status: 502, headers: CORS });
    }

    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    out.delete('set-cookie');

    const path = target.split('?')[0].toLowerCase();
    const isPlaylist =
      /mpegurl/i.test(upstream.headers.get('content-type') || '') || path.endsWith('.m3u8');

    // সেগমেন্ট (.ts/.m4s) / key ফাইল -> সোজা passthrough
    if (!isPlaylist) {
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    // প্লেলিস্ট -> প্রতিটা URI আবার এই worker দিয়ে ঘুরাই + টোকেন জুড়ে দিই
    const text = await upstream.text();
    const base = new URL(target);
    const token = base.searchParams.get('edge-cache-token');

    const proxify = (raw) => {
      const abs = new URL(raw, base);
      if (token && !abs.searchParams.has('edge-cache-token')) {
        abs.searchParams.set('edge-cache-token', token);
      }
      return `${self.origin}${self.pathname}?url=${encodeURIComponent(abs.href)}`;
    };

    const body = text
      .split('\n')
      .map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA এর URI="..."
          return t.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxify(u)}"`);
        }
        return proxify(t);
      })
      .join('\n');

    out.set('content-type', 'application/vnd.apple.mpegurl');
    out.delete('content-length');
    out.delete('content-encoding');

    return new Response(body, { status: 200, headers: out });
  },
};
