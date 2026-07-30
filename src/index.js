const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let memoryToken = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/admin") {
        return Response.redirect(`${url.origin}/admin/`, 302);
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        return await handleStatus(request, env, ctx);
      }

      if (url.pathname === "/api/admin/config" && request.method === "GET") {
        requireAdmin(request, env);
        return await handleAdminConfig(env);
      }

      if (url.pathname === "/api/admin/google/start" && request.method === "GET") {
        requireAdmin(request, env);
        return await handleGoogleStart(request, env);
      }

      if (url.pathname === "/api/admin/google/callback" && request.method === "GET") {
        return await handleGoogleCallback(request, env);
      }

      if (url.pathname === "/api/admin/calendars" && request.method === "GET") {
        requireAdmin(request, env);
        return await handleCalendarList(env);
      }

      if (url.pathname === "/api/admin/calendars" && request.method === "PUT") {
        requireAdmin(request, env);
        return await handleSaveCalendars(request, env, ctx);
      }

      if (url.pathname === "/api/admin/disconnect" && request.method === "DELETE") {
        requireAdmin(request, env);
        return await handleDisconnect(env, ctx, request);
      }

      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse);
    } catch (error) {
      console.error(error);
      const status = error instanceof HttpError ? error.status : 500;
      const message = status === 500 ? "Errore interno del servizio." : error.message;
      return json({ error: message }, status, { "Cache-Control": "no-store" });
    }
  },
};

async function handleStatus(request, env, ctx) {
  const cached = await caches.default.match(request);
  if (cached) return cached;

  const selectedCalendars = (await env.APP_KV.get("selected_calendars", "json")) || [];
  if (!Array.isArray(selectedCalendars) || selectedCalendars.length === 0) {
    return json(
      {
        state: "error",
        title: "CONFIGURAZIONE NECESSARIA",
        label: "",
        time: "",
        relative: "Collega Google Calendar e seleziona almeno un calendario.",
        updatedAt: new Date().toISOString(),
      },
      503,
      { "Cache-Control": "no-store" },
    );
  }

  const accessToken = await getAccessToken(env);
  const intervals = await getMergedBusyIntervals(accessToken, selectedCalendars, env);
  const status = computeStatus(intervals, env);

  const response = json(status, 200, {
    "Cache-Control": "public, max-age=20, s-maxage=20",
  });
  ctx.waitUntil(caches.default.put(request, response.clone()));
  return response;
}

async function handleAdminConfig(env) {
  const connected = Boolean(await env.APP_KV.get("google_refresh_token"));
  const selected = (await env.APP_KV.get("selected_calendars", "json")) || [];
  return json(
    {
      connected,
      selectedCount: Array.isArray(selected) ? selected.length : 0,
      timezone: env.TIME_ZONE || "Europe/Rome",
      warningMinutes: numberFromEnv(env.WARNING_MINUTES, 30),
    },
    200,
    { "Cache-Control": "no-store" },
  );
}

async function handleGoogleStart(request, env) {
  assertOAuthConfig(env);
  const state = await createOAuthState(env);
  const redirectUri = oauthRedirectUri(request);
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);

  return json({ url: authUrl.toString(), redirectUri }, 200, {
    "Cache-Control": "no-store",
  });
}

async function handleGoogleCallback(request, env) {
  assertOAuthConfig(env);
  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return Response.redirect(`${url.origin}/admin/?oauth=denied`, 302);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new HttpError(400, "Risposta OAuth incompleta.");

  await verifyOAuthState(state, env);

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: oauthRedirectUri(request),
    }),
  });

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) {
    console.error("OAuth token exchange failed", tokenData);
    throw new HttpError(502, "Google non ha completato il collegamento.");
  }
  if (!tokenData.refresh_token) {
    throw new HttpError(
      400,
      "Google non ha restituito un refresh token. Revoca l'accesso all'app dal tuo account Google e ripeti il collegamento.",
    );
  }

  await env.APP_KV.put(
    "google_refresh_token",
    await encryptString(tokenData.refresh_token, env.TOKEN_ENCRYPTION_KEY),
  );
  await env.APP_KV.delete("google_access_token");
  memoryToken = null;

  return Response.redirect(`${url.origin}/admin/?oauth=connected`, 302);
}

async function handleCalendarList(env) {
  const accessToken = await getAccessToken(env);
  const selectedIds = new Set((await env.APP_KV.get("selected_calendars", "json")) || []);
  const calendars = [];
  let pageToken = "";

  do {
    const url = new URL(`${GOOGLE_CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showHidden", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("CalendarList failed", data);
      throw new HttpError(502, "Impossibile recuperare l'elenco dei calendari.");
    }

    for (const item of data.items || []) {
      if (item.deleted) continue;
      calendars.push({
        id: item.id,
        name: item.summaryOverride || item.summary || item.id,
        primary: Boolean(item.primary),
        hidden: Boolean(item.hidden),
        accessRole: item.accessRole || "reader",
        selected: selectedIds.has(item.id),
      });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  calendars.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.name.localeCompare(b.name, "it", { sensitivity: "base" });
  });

  return json({ calendars }, 200, { "Cache-Control": "no-store" });
}

async function handleSaveCalendars(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.ids)) {
    throw new HttpError(400, "Invia un elenco di calendari valido.");
  }

  const ids = [...new Set(body.ids)]
    .filter((id) => typeof id === "string" && id.length > 0 && id.length <= 1024)
    .slice(0, 200);

  await env.APP_KV.put("selected_calendars", JSON.stringify(ids));
  ctx.waitUntil(clearStatusCache(request));
  return json({ saved: true, selectedCount: ids.length }, 200, {
    "Cache-Control": "no-store",
  });
}

async function handleDisconnect(env, ctx, request) {
  await Promise.all([
    env.APP_KV.delete("google_refresh_token"),
    env.APP_KV.delete("google_access_token"),
    env.APP_KV.delete("selected_calendars"),
  ]);
  memoryToken = null;
  ctx.waitUntil(clearStatusCache(request));
  return json({ disconnected: true }, 200, { "Cache-Control": "no-store" });
}

async function getMergedBusyIntervals(accessToken, calendarIds, env) {
  const now = Date.now();
  const lookaheadDays = numberFromEnv(env.LOOKAHEAD_DAYS, 14);
  const timeMin = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now + lookaheadDays * 24 * 60 * 60 * 1000).toISOString();
  const timezone = env.TIME_ZONE || "Europe/Rome";
  const intervals = [];

  for (const ids of chunk(calendarIds, 50)) {
    const response = await fetch(`${GOOGLE_CALENDAR_API}/freeBusy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        timeZone: timezone,
        calendarExpansionMax: 50,
        items: ids.map((id) => ({ id })),
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("FreeBusy failed", data);
      throw new HttpError(502, "Impossibile leggere la disponibilità da Google Calendar.");
    }

    for (const calendar of Object.values(data.calendars || {})) {
      if (calendar.errors?.length) {
        console.warn("Calendar freebusy errors", calendar.errors);
        continue;
      }
      for (const busy of calendar.busy || []) {
        const start = Date.parse(busy.start);
        const end = Date.parse(busy.end);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          intervals.push({ start, end });
        }
      }
    }
  }

  return mergeIntervals(intervals);
}

function computeStatus(intervals, env) {
  const now = Date.now();
  const warningMs = numberFromEnv(env.WARNING_MINUTES, 30) * 60 * 1000;
  const timezone = env.TIME_ZONE || "Europe/Rome";
  const current = intervals.find((interval) => interval.start <= now && interval.end > now);
  const next = intervals.find((interval) => interval.start > now);

  if (current) {
    const remaining = current.end - now;
    const soon = remaining <= warningMs;
    return {
      state: soon ? "yellow" : "red",
      title: soon ? "PRESTO DISPONIBILE" : "NON DISPONIBILE",
      label: "Disponibile alle:",
      time: formatTime(current.end, timezone),
      relative: formatRelative(remaining),
      nextChangeAt: new Date(current.end).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  }

  if (next && next.start - now <= warningMs) {
    const remaining = next.start - now;
    return {
      state: "yellow",
      title: "PRESTO NON DISPONIBILE",
      label: "Non disponibile alle:",
      time: formatTime(next.start, timezone),
      relative: formatRelative(remaining),
      nextChangeAt: new Date(next.start).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  }

  const showNextToday = next && isSameCalendarDay(now, next.start, timezone);
  return {
    state: "green",
    title: "DISPONIBILE",
    label: showNextToday ? "Non disponibile alle:" : "",
    time: showNextToday ? formatTime(next.start, timezone) : "",
    relative: showNextToday ? formatRelative(next.start - now) : "",
    nextChangeAt: next ? new Date(next.start).toISOString() : null,
    updatedAt: new Date(now).toISOString(),
  };
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
    } else {
      last.end = Math.max(last.end, interval.end);
    }
  }
  return merged;
}

async function getAccessToken(env) {
  assertOAuthConfig(env);
  const now = Date.now();
  if (memoryToken?.expiresAt > now + 60_000) return memoryToken.accessToken;

  const cachedEncrypted = await env.APP_KV.get("google_access_token");
  if (cachedEncrypted) {
    try {
      const cached = JSON.parse(await decryptString(cachedEncrypted, env.TOKEN_ENCRYPTION_KEY));
      if (cached.expiresAt > now + 60_000 && cached.accessToken) {
        memoryToken = cached;
        return cached.accessToken;
      }
    } catch (error) {
      console.warn("Ignoring invalid access token cache", error);
    }
  }

  const encryptedRefreshToken = await env.APP_KV.get("google_refresh_token");
  if (!encryptedRefreshToken) {
    throw new HttpError(503, "Google Calendar non è ancora collegato.");
  }
  const refreshToken = await decryptString(encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    console.error("Access token refresh failed", data);
    throw new HttpError(503, "Il collegamento a Google Calendar è scaduto: ricollegalo dalla pagina amministrativa.");
  }

  const token = {
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600) * 1000,
  };
  memoryToken = token;
  const encryptedToken = await encryptString(JSON.stringify(token), env.TOKEN_ENCRYPTION_KEY);
  await env.APP_KV.put("google_access_token", encryptedToken, {
    expirationTtl: Math.max(60, Number(data.expires_in || 3600) - 30),
  });
  return token.accessToken;
}

async function createOAuthState(env) {
  const nonce = crypto.randomUUID();
  const payload = {
    nonce,
    exp: Date.now() + 10 * 60 * 1000,
  };
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSign(encodedPayload, env.STATE_SECRET);
  await env.APP_KV.put(`oauth_state:${nonce}`, "1", { expirationTtl: 600 });
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

async function verifyOAuthState(state, env) {
  const [encodedPayload, encodedSignature, extra] = state.split(".");
  if (!encodedPayload || !encodedSignature || extra) {
    throw new HttpError(400, "Stato OAuth non valido.");
  }

  const expected = await hmacSign(encodedPayload, env.STATE_SECRET);
  const received = base64UrlDecode(encodedSignature);
  if (!constantTimeEqual(expected, received)) {
    throw new HttpError(400, "Firma OAuth non valida.");
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(encodedPayload)));
  } catch {
    throw new HttpError(400, "Stato OAuth non leggibile.");
  }

  if (!payload.nonce || !payload.exp || payload.exp < Date.now()) {
    throw new HttpError(400, "Stato OAuth scaduto.");
  }

  const nonceKey = `oauth_state:${payload.nonce}`;
  const exists = await env.APP_KV.get(nonceKey);
  if (!exists) throw new HttpError(400, "Stato OAuth già usato o scaduto.");
  await env.APP_KV.delete(nonceKey);
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function encryptString(value, secret) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value)),
  );
  return JSON.stringify({
    v: 1,
    iv: base64UrlEncode(iv),
    data: base64UrlEncode(encrypted),
  });
}

async function decryptString(serialized, secret) {
  const parsed = JSON.parse(serialized);
  if (parsed.v !== 1 || !parsed.iv || !parsed.data) throw new Error("Encrypted value malformed");
  const key = await encryptionKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(parsed.iv) },
    key,
    base64UrlDecode(parsed.data),
  );
  return decoder.decode(decrypted);
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function oauthRedirectUri(request) {
  return `${new URL(request.url).origin}/api/admin/google/callback`;
}

function assertOAuthConfig(env) {
  const missing = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "STATE_SECRET",
    "TOKEN_ENCRYPTION_KEY",
  ].filter((name) => !env[name]);
  if (missing.length) {
    throw new HttpError(503, `Configurazione mancante: ${missing.join(", ")}`);
  }
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) throw new HttpError(503, "ADMIN_TOKEN non configurato.");
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match || !constantTimeEqual(encoder.encode(match[1]), encoder.encode(env.ADMIN_TOKEN))) {
    throw new HttpError(401, "Accesso amministrativo non autorizzato.");
  }
}

function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array)) a = new Uint8Array(a);
  if (!(b instanceof Uint8Array)) b = new Uint8Array(b);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (a[i % a.length] || 0) ^ (b[i % b.length] || 0);
  }
  return difference === 0;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function formatTime(timestamp, timezone) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatRelative(milliseconds) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `tra ${minutes} ${minutes === 1 ? "minuto" : "minuti"}`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) return `tra ${hours} ${hours === 1 ? "ora" : "ore"}`;
  return `tra ${hours} ${hours === 1 ? "ora" : "ore"} e ${remaining} minuti`;
}

function isSameCalendarDay(firstTimestamp, secondTimestamp, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(firstTimestamp)) === formatter.format(new Date(secondTimestamp));
}

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function clearStatusCache(request) {
  const origin = new URL(request.url).origin;
  await caches.default.delete(new Request(`${origin}/api/status`));
}

function json(body, status = 200, headers = {}) {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...headers,
      },
    }),
  );
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
