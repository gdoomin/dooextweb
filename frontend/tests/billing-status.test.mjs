import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchBillingStatus } from "../src/lib/convert.ts";

test("parallel membership requests share a lookup but later refreshes use fresh data", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ user_id: "legacy-user", plan_code: "legacy", legacy_full_access: true, is_new_pricing_user: false }), { headers: { "content-type": "application/json" } });
  };
  try {
    const first = fetchBillingStatus("legacy-user", "", "test-token");
    const second = fetchBillingStatus("legacy-user", "", "test-token");
    assert.equal(first, second);
    const [status] = await Promise.all([first, second]);
    assert.equal(status.legacy_full_access, true);
    assert.equal(status.is_new_pricing_user, false);
    assert.equal(calls, 1);
    await fetchBillingStatus("legacy-user", "", "test-token");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("failed requests are removed so membership can be checked again", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(calls === 1 ? { detail: "retry" } : { plan_code: "legacy" }), { status: calls === 1 ? 503 : 200 });
  };
  try {
    await assert.rejects(fetchBillingStatus("retry-user", "", "test-token"), /retry/);
    assert.equal((await fetchBillingStatus("retry-user", "", "test-token")).plan_code, "legacy");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
