const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_API_BASE = "https://www.googleapis.com";
const GOOGLE_CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly"
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cleanSecret(value) {
  return String(value || "").trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function googleCalendarEnabled(env) {
  return Boolean(cleanSecret(env.GOOGLE_CALENDAR_CLIENT_ID) && cleanSecret(env.GOOGLE_CALENDAR_CLIENT_SECRET));
}

export function googleCalendarConfig(env) {
  const clientId = cleanSecret(env.GOOGLE_CALENDAR_CLIENT_ID);
  const clientSecret = cleanSecret(env.GOOGLE_CALENDAR_CLIENT_SECRET);
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CALENDAR_NOT_CONFIGURED");
  return { clientId, clientSecret };
}

export function googleCalendarRedirectUri(env, request) {
  const uri = new URL(String(env.GOOGLE_CALENDAR_REDIRECT_URI || "/api/calendar/google/callback"), new URL(request.url).origin);
  const local = uri.hostname === "localhost" || uri.hostname === "127.0.0.1";
  if (uri.protocol !== "https:" && !local) throw new Error("GOOGLE_CALENDAR_REDIRECT_URI_DEVE_USAR_HTTPS");
  if (uri.pathname !== "/api/calendar/google/callback" || uri.search || uri.hash) {
    throw new Error("GOOGLE_CALENDAR_REDIRECT_URI_INVALIDA");
  }
  return uri.toString();
}

export async function sha256Base64Url(value) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value)))));
}

export function buildGoogleCalendarAuthorizationUrl(env, redirectUri, state, verifier) {
  const { clientId } = googleCalendarConfig(env);
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  return sha256Base64Url(verifier).then(challenge => {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  });
}

async function googleTokenRequest(env, values) {
  const { clientId, clientSecret } = googleCalendarConfig(env);
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...values })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error(String(data.error || "GOOGLE_TOKEN_REQUEST_FAILED"));
    error.code = String(data.error || "GOOGLE_TOKEN_REQUEST_FAILED");
    throw error;
  }
  return data;
}

export function exchangeGoogleCalendarCode(env, code, redirectUri, verifier) {
  return googleTokenRequest(env, {
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    grant_type: "authorization_code"
  });
}

export function refreshGoogleAccessToken(env, refreshToken) {
  return googleTokenRequest(env, { refresh_token: refreshToken, grant_type: "refresh_token" });
}

async function calendarKey(env) {
  const secret = cleanSecret(env.GOOGLE_CALENDAR_TOKEN_KEY);
  if (secret.length < 32) throw new Error("GOOGLE_CALENDAR_TOKEN_KEY_NOT_CONFIGURED");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function tokenAdditionalData(userId) {
  return encoder.encode(`updown:google-calendar:${userId}`);
}

export async function encryptGoogleRefreshToken(env, userId, refreshToken) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenAdditionalData(userId) },
    await calendarKey(env),
    encoder.encode(String(refreshToken))
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptGoogleRefreshToken(env, userId, sealed) {
  const [version, ivValue, ciphertextValue] = String(sealed || "").split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue) throw new Error("GOOGLE_CALENDAR_TOKEN_INVALID");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivValue), additionalData: tokenAdditionalData(userId) },
      await calendarKey(env),
      base64UrlToBytes(ciphertextValue)
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("GOOGLE_CALENDAR_TOKEN_DECRYPT_FAILED");
  }
}

export async function googleApi(accessToken, path, search = {}) {
  const url = new URL(path, GOOGLE_API_BASE);
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(data.error?.message || "GOOGLE_CALENDAR_API_FAILED"));
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function fetchGoogleProfile(accessToken) {
  const profile = await googleApi(accessToken, "/oauth2/v2/userinfo");
  return { id: String(profile.id || ""), email: String(profile.email || "").trim().toLowerCase() };
}

export async function fetchGoogleCalendars(accessToken) {
  const calendars = [];
  let pageToken;
  do {
    const page = await googleApi(accessToken, "/calendar/v3/users/me/calendarList", {
      maxResults: 250,
      minAccessRole: "reader",
      pageToken
    });
    for (const item of page.items || []) {
      if (!item.id) continue;
      calendars.push({
        id: String(item.id),
        summary: String(item.summaryOverride || item.summary || item.id),
        primary: Boolean(item.primary),
        selected: item.selected !== false,
        backgroundColor: /^#[0-9a-f]{6}$/i.test(item.backgroundColor || "") ? item.backgroundColor : null
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken && calendars.length < 500);
  return calendars.slice(0, 500);
}

function safeGoogleLink(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && (url.hostname === "calendar.google.com" || url.hostname.endsWith(".google.com"))
      ? url.toString()
      : null;
  } catch { return null; }
}

export async function fetchGoogleEvents(accessToken, calendarIds, { timeMin, timeMax, maxPerCalendar = 50 } = {}) {
  const results = await Promise.all(calendarIds.slice(0, 50).map(async calendarId => {
    const page = await googleApi(accessToken, `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      showDeleted: false,
      maxResults: maxPerCalendar
    });
    return (page.items || []).filter(event => event.status !== "cancelled").map(event => ({
      id: String(event.id || event.iCalUID || ""),
      calendar_id: calendarId,
      title: String(event.summary || "Compromisso").slice(0, 300),
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      all_day: Boolean(event.start?.date && !event.start?.dateTime),
      location: event.location ? String(event.location).slice(0, 500) : null,
      html_link: safeGoogleLink(event.htmlLink),
      status: String(event.status || "confirmed")
    }));
  }));
  return results.flat().filter(event => event.id && event.start)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}
