
const CDN_HOST = "prod-linear-media.toffeelive.com";

const UPSTREAM_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36",
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://toffeelive.com/",
  "origin": "https://toffeelive.com"
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range, Content-Type",
  "access-control-expose-headers":
    "Content-Length, Content-Range, Accept-Ranges, ETag",
  "cache-control": "no-store"
};

function response(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, ...extra }
  });
}

function isAllowedURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === CDN_HOST;
  } catch {
    return false;
  }
}

export default {
  async fetch(request) {
    const self = new URL(request.url);

    if (request.method === "OPTIONS") {
      return response(null, 204);
    }

    if (!["GET", "HEAD"].includes(request.method)) {
      return response("Method not allowed", 405);
    }

    let target = self.searchParams.get("url");

    // Optional shorthand: ?ch=channel_i&token=...
    if (!target) {
      const ch = self.searchParams.get("ch");
      const token = self.searchParams.get("token");

      if (ch && token && /^[a-zA-Z0-9_-]+$/.test(ch)) {
        const u = new URL(
          `https://${CDN_HOST}/cdn/live/${ch}/playlist.m3u8`
        );
        u.searchParams.set("edge-cache-token", token);
        target = u.href;
      }
    }

    if (!target) {
      return response(
        "Usage: /?url=ENCODED_M3U8_URL",
        400
      );
    }

    if (!isAllowedURL(target)) {
      return response(
        "Invalid URL: only the configured CDN host is allowed",
        400
      );
    }

    const headers = new Headers(UPSTREAM_HEADERS);

    const range = request.headers.get("range");
    if (range) headers.set("range", range);

    let upstream;

    try {
      upstream = await fetch(target, {
        method: request.method,
        headers,
        redirect: "follow"
      });
    } catch (err) {
      console.error("UPSTREAM_FETCH_ERROR", err.message);
      return response("Upstream fetch failed", 502, {
        "x-proxy-error": "upstream-fetch-failed"
      });
    }

    const finalURL = upstream.url || target;

    console.log(JSON.stringify({
      event: "upstream-response",
      status: upstream.status,
      contentType: upstream.headers.get("content-type"),
      finalHost: (() => {
        try { return new URL(finalURL).hostname; }
        catch { return "unknown"; }
      })()
    }));

    // Prevent redirects from silently moving requests to another host.
    if (!isAllowedURL(finalURL)) {
      await upstream.body?.cancel();
      return response("Unexpected upstream redirect host", 502);
    }

    const out = new Headers(CORS);

    for (const name of [
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified"
    ]) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    const path = new URL(finalURL).pathname.toLowerCase();

    const isPlaylist =
      path.endsWith(".m3u8") ||
      /mpegurl/i.test(contentType);

    // Preserve upstream failures instead of turning them into HTTP 200.
    if (!upstream.ok) {
      const status = upstream.status;
      const detail = `Upstream returned HTTP ${status}`;

      console.error("UPSTREAM_HTTP_ERROR", detail);

      await upstream.body?.cancel();

      return response(detail, status, {
        "x-upstream-status": String(status)
      });
    }

    // HEAD: return headers without reading the body.
    if (request.method === "HEAD") {
      out.set("content-type", contentType || "application/octet-stream");
      return new Response(null, {
        status: upstream.status,
        headers: out
      });
    }

    // Non-playlist files (segments, maps, keys): pass through.
    if (!isPlaylist) {
      out.set(
        "content-type",
        contentType || "application/octet-stream"
      );

      return new Response(upstream.body, {
        status: upstream.status,
        headers: out
      });
    }

    const playlist = await upstream.text();

    // Detect HTML error pages mistakenly returned as HTTP 200.
    if (/^\s*<!doctype html|^\s*<html/i.test(playlist)) {
      console.error("Unexpected HTML returned for playlist");
      return response("Expected M3U8 but upstream returned HTML", 502);
    }

    const base = new URL(finalURL);

    function proxify(raw) {
      const value = raw.trim();
      if (!value) return raw;

      let absolute;

      try {
        absolute = new URL(value, base);
      } catch {
        return raw;
      }

      // Do not proxy unrelated or untrusted hosts.
      if (
        absolute.protocol !== "https:" ||
        absolute.hostname !== CDN_HOST
      ) {
        return raw;
      }

      const proxyURL = new URL(self.pathname, self.origin);
      proxyURL.searchParams.set("url", absolute.href);

      return proxyURL.href;
    }

    const rewritten = playlist
      .split(/\r?\n/)
      .map(line => {
        const trimmed = line.trim();

        if (!trimmed) return line;

        if (trimmed.startsWith("#")) {
          return line.replace(
            /URI="([^"]+)"/g,
            (_match, uri) => `URI="${proxify(uri)}"`
          );
        }

        return proxify(trimmed);
      })
      .join("\n");

    out.set("content-type", "application/vnd.apple.mpegurl; charset=utf-8");

    console.log(JSON.stringify({
      event: "playlist-rewritten",
      status: upstream.status,
      lines: rewritten.split("\n").length
    }));

    return new Response(rewritten, {
      status: 200,
      headers: out
    });
  }
};

