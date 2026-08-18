import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  buildGoogleCalendarAuthorizationUrl,
  decryptGoogleRefreshToken,
  encryptGoogleRefreshToken,
  googleCalendarEnabled,
  googleCalendarRedirectUri
} from "../src/google-calendar.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const env = {
  GOOGLE_CALENDAR_CLIENT_ID: "calendar-client.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CALENDAR_TOKEN_KEY: "test-only-key-with-at-least-32-characters"
};

test("autorização do Google Agenda usa somente leitura, PKCE e acesso offline", async () => {
  const redirectUri = "https://noc.example.test/api/calendar/google/callback";
  const authorization = new URL(await buildGoogleCalendarAuthorizationUrl(env, redirectUri, "secure-state", "v".repeat(64)));
  assert.equal(authorization.origin, "https://accounts.google.com");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("prompt"), "consent");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorization.searchParams.get("scope"), /calendar\.readonly/);
  assert.doesNotMatch(authorization.searchParams.get("scope"), /calendar\.events(?!\.readonly)/);
});

test("refresh token é cifrado por usuário e recuperado somente com a mesma chave", async () => {
  const sealed = await encryptGoogleRefreshToken(env, 42, "refresh-token-super-secreto");
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(sealed, /refresh-token/);
  assert.equal(await decryptGoogleRefreshToken(env, 42, sealed), "refresh-token-super-secreto");
  await assert.rejects(() => decryptGoogleRefreshToken(env, 43, sealed), /DECRYPT_FAILED/);
});

test("configuração rejeita callback insegura ou em caminho diferente", () => {
  assert.equal(googleCalendarEnabled(env), true);
  assert.equal(
    googleCalendarRedirectUri({ ...env, GOOGLE_CALENDAR_REDIRECT_URI: "https://noc.example.test/api/calendar/google/callback" }, { url: "https://noc.example.test/" }),
    "https://noc.example.test/api/calendar/google/callback"
  );
  assert.throws(
    () => googleCalendarRedirectUri({ ...env, GOOGLE_CALENDAR_REDIRECT_URI: "http://noc.example.test/api/calendar/google/callback" }, { url: "https://noc.example.test/" }),
    /HTTPS/
  );
  assert.throws(
    () => googleCalendarRedirectUri({ ...env, GOOGLE_CALENDAR_REDIRECT_URI: "https://noc.example.test/callback-errado" }, { url: "https://noc.example.test/" }),
    /INVALIDA/
  );
});
