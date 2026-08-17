const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}

function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

function requireHttpsUrl(value, label, { allowLocalhost = false } = {}) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label} inválida.`); }
  const local = allowLocalhost && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`${label} deve usar HTTPS.`);
  }
  if (url.username || url.password || url.hash) throw new Error(`${label} inválida.`);
  return url;
}

async function fetchJson(url, init, label) {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init?.headers || {}) }
  });
  if (!response.ok) throw new Error(`${label} retornou HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (contentLength > 262144) throw new Error(`${label} excedeu o tamanho permitido.`);
  return response.json();
}

export function oauthEnabled(env) {
  return Boolean(String(env.OAUTH_ISSUER || "").trim() && String(env.OAUTH_CLIENT_ID || "").trim());
}

export function oauthConfig(env) {
  if (!oauthEnabled(env)) throw new Error("OAuth/OIDC não configurado.");
  const issuerUrl = requireHttpsUrl(String(env.OAUTH_ISSUER).trim().replace(/\/+$/, ""), "OAUTH_ISSUER", {
    allowLocalhost: env.OAUTH_ALLOW_INSECURE_LOCALHOST === "true"
  });
  return {
    issuer: issuerUrl.toString().replace(/\/$/, ""),
    clientId: String(env.OAUTH_CLIENT_ID).trim(),
    clientSecret: String(env.OAUTH_CLIENT_SECRET || ""),
    scopes: String(env.OAUTH_SCOPES || "openid profile email").trim(),
    buttonLabel: String(env.OAUTH_BUTTON_LABEL || "Entrar com conta corporativa").slice(0, 80)
  };
}

export async function discoverProvider(env) {
  const config = oauthConfig(env);
  const discoveryUrl = `${config.issuer}/.well-known/openid-configuration`;
  const document = await fetchJson(discoveryUrl, undefined, "Descoberta OIDC");
  if (String(document.issuer || "").replace(/\/$/, "") !== config.issuer) {
    throw new Error("Issuer retornado pela descoberta OIDC não confere.");
  }
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    requireHttpsUrl(document[field], field, { allowLocalhost: env.OAUTH_ALLOW_INSECURE_LOCALHOST === "true" });
  }
  return { config, document };
}

export function randomBase64Url(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Base64Url(value) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function constantTimeEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(String(left))),
    crypto.subtle.digest("SHA-256", encoder.encode(String(right)))
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(leftHash, rightHash);
  }
  // Node.js ainda não expõe a extensão timingSafeEqual do runtime Workers.
  // O fallback compara os dois digests SHA-256 (sempre 32 bytes) sem saída antecipada.
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function safeReturnPath(value) {
  const path = String(value || "/");
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n\\]/.test(path)) return "/";
  if (path.startsWith("/api/auth/oauth/")) return "/";
  return path.slice(0, 512);
}

export async function buildAuthorizationRequest(env, redirectUri, state, nonce, verifier) {
  const { config, document } = await discoverProvider(env);
  const url = new URL(document.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeAuthorizationCode(env, code, redirectUri, verifier, expectedNonce) {
  const { config, document } = await discoverProvider(env);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: verifier
  });
  if (config.clientSecret) form.set("client_secret", config.clientSecret);

  const token = await fetchJson(document.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  }, "Endpoint de token OIDC");
  if (!token.id_token) throw new Error("O provedor não retornou um ID Token.");

  const claims = await verifyIdToken(token.id_token, document, config.clientId, expectedNonce);
  if (document.userinfo_endpoint && token.access_token) {
    const userinfo = await fetchJson(document.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    }, "UserInfo OIDC");
    if (userinfo.sub !== claims.sub) throw new Error("O subject do UserInfo não confere.");
    return { ...claims, ...userinfo, iss: claims.iss, sub: claims.sub };
  }
  return claims;
}

async function verifyIdToken(idToken, discovery, clientId, expectedNonce) {
  const parts = String(idToken).split(".");
  if (parts.length !== 3) throw new Error("ID Token inválido.");
  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Algoritmo de assinatura OIDC não permitido.");

  const jwks = await fetchJson(discovery.jwks_uri, undefined, "JWKS OIDC");
  const jwk = Array.isArray(jwks.keys)
    ? jwks.keys.find(key => key.kid === header.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256"))
    : null;
  if (!jwk) throw new Error("Chave de assinatura OIDC não encontrada.");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!validSignature) throw new Error("Assinatura do ID Token inválida.");

  const now = Math.floor(Date.now() / 1000);
  const issuer = String(discovery.issuer || "").replace(/\/$/, "");
  if (String(claims.iss || "").replace(/\/$/, "") !== issuer) throw new Error("Issuer do ID Token inválido.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw new Error("Audience do ID Token inválida.");
  if (audiences.length > 1 && claims.azp !== clientId) throw new Error("Authorized party do ID Token inválida.");
  if (!Number.isFinite(claims.exp) || claims.exp <= now - 60) throw new Error("ID Token expirado.");
  if (Number.isFinite(claims.nbf) && claims.nbf > now + 60) throw new Error("ID Token ainda não é válido.");
  if (Number.isFinite(claims.iat) && claims.iat > now + 60) throw new Error("ID Token emitido no futuro.");
  if (!claims.sub || !(await constantTimeEqual(claims.nonce || "", expectedNonce))) {
    throw new Error("Nonce do ID Token inválido.");
  }
  return claims;
}
