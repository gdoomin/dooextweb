import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRecoveryUrl, getRecoveryRedirect, initializePasswordRecovery, EXPIRED_RECOVERY_MESSAGE } from "../src/lib/password-recovery.ts";

const session = { user: { id: "test-user" } };

test("the reported expired link routes to reset and never accepts an existing session", async () => {
  const url = new URL("http://127.0.0.1:3000/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=");
  assert.ok(getRecoveryRedirect(url).startsWith("/reset-password#"));
  await assert.rejects(initializePasswordRecovery({ auth: { getSession() { assert.fail("must not use an existing session for an invalid link"); } } }, url), { message: EXPIRED_RECOVERY_MESSAGE });
});

test("PKCE uses the SDK's completed initialization without a second code exchange", async () => {
  let calls = 0;
  const ready = await initializePasswordRecovery({ auth: {
    getSession: async () => { calls++; return { data: { session }, error: null }; },
    exchangeCodeForSession: () => assert.fail("one-time code must not be exchanged twice"),
  } }, new URL("http://localhost:3000/reset-password?code=one-time"));
  assert.equal(ready, true);
  assert.equal(calls, 1);
});

test("a PKCE link without a session tells the user to request a fresh link", async () => {
  await assert.rejects(initializePasswordRecovery({ auth: { getSession: async () => ({ data: { session: null }, error: null }) } }, new URL("http://localhost:3000/reset-password?code=used")), /최신 링크/);
});

test("legacy implicit recovery emails explicitly establish their session", async () => {
  let tokens;
  await initializePasswordRecovery({ auth: {
    setSession: async (value) => { tokens = value; return { error: null }; },
    getSession: async () => ({ data: { session }, error: null }),
  } }, new URL("http://localhost:3000/reset-password#type=recovery&access_token=test-access&refresh_token=test-refresh"));
  assert.deepEqual(tokens, { access_token: "test-access", refresh_token: "test-refresh" });
});

test("custom recovery token hashes are verified as recovery tokens", async () => {
  let verified;
  await initializePasswordRecovery({ auth: {
    verifyOtp: async (value) => { verified = value; return { error: null }; },
    getSession: async () => ({ data: { session }, error: null }),
  } }, new URL("http://localhost:3000/reset-password?type=recovery&token_hash=test-hash"));
  assert.deepEqual(verified, { type: "recovery", token_hash: "test-hash" });
});

test("removes credentials and errors from URL while preserving the return path", () => {
  assert.equal(cleanRecoveryUrl(new URL("http://localhost:3000/reset-password?next=%2Fjobs&code=secret&type=recovery&token_hash=secret&error=error&error_code=otp_expired&error_description=bad#access_token=secret")), "/reset-password?next=%2Fjobs");
  assert.equal(getRecoveryRedirect(new URL("http://localhost:3000/#map")), null);
  assert.equal(getRecoveryRedirect(new URL("http://localhost:3000/reset-password#error=access_denied")), null);
});
