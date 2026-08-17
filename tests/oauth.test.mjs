import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  buildAuthorizationRequest,
  constantTimeEqual,
  exchangeAuthorizationCode,
  safeReturnPath
} from "../src/oauth.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const base64url = (value) => Buffer.from(value).toString("base64url");

test("safeReturnPath bloqueia redirecionamentos externos", () => {
  assert.equal(safeReturnPath("/dashboard.html?modo=tv"), "/dashboard.html?modo=tv");
  assert.equal(safeReturnPath("//evil.example/roubo"), "/");
  assert.equal(safeReturnPath("https://evil.example/roubo"), "/");
  assert.equal(safeReturnPath("/ok\r\nLocation:https://evil.example"), "/");
});

test("comparação de segredos funciona sobre hashes de tamanho fixo", async () => {
  assert.equal(await constantTimeEqual("estado-seguro", "estado-seguro"), true);
  assert.equal(await constantTimeEqual("estado-seguro", "outro"), false);
});

test("fluxo OIDC usa PKCE e valida assinatura, issuer, audience e nonce", async (t) => {
  const issuer = "https://id.example.test";
  const env = {
    OAUTH_ISSUER: issuer,
    OAUTH_CLIENT_ID: "noc-client",
    OAUTH_CLIENT_SECRET: "test-only-secret"
  };
  const nonce = "nonce-de-teste";
  const redirectUri = "https://noc.example.test/api/auth/oauth/callback";
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "key-1";
  publicJwk.alg = "RS256";

  const header = base64url(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuer,
    sub: "user-123",
    aud: env.OAUTH_CLIENT_ID,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    email: "noc@example.test",
    email_verified: true
  }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  const idToken = `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;

  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    userinfo_endpoint: `${issuer}/userinfo`
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json(discovery);
    if (url.endsWith("/token")) {
      assert.match(String(init.body), /code_verifier=/);
      return Response.json({ id_token: idToken, access_token: "access-token" });
    }
    if (url.endsWith("/jwks")) return Response.json({ keys: [publicJwk] });
    if (url.endsWith("/userinfo")) return Response.json({ sub: "user-123", name: "Operador NOC" });
    throw new Error(`URL inesperada: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const authorization = new URL(await buildAuthorizationRequest(env, redirectUri, "state", nonce, "v".repeat(64)));
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("nonce"), nonce);

  const claims = await exchangeAuthorizationCode(env, "authorization-code", redirectUri, "v".repeat(64), nonce);
  assert.equal(claims.sub, "user-123");
  assert.equal(claims.name, "Operador NOC");
  await assert.rejects(
    exchangeAuthorizationCode(env, "authorization-code", redirectUri, "v".repeat(64), "nonce-incorreto"),
    /Nonce/
  );
});
