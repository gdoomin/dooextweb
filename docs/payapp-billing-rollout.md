# PayApp Billing Rollout Guide

## 1) Current behavior

- Existing members (joined before `DOO_BILLING_CUTOVER_AT`) are marked as `legacy_full_access=true`.
- Legacy users keep full features and do not need payment.
- New members are on `free` and can upgrade to `lite` or `pro`.

## 2) Pricing (monthly)

- `free`: 0 KRW
- `lite`: 3,900 KRW
- `pro`: 8,900 KRW

## 3) Required backend env vars

Set these in Railway backend service:

- `DOO_BILLING_ENABLED=true`
- `DOO_BILLING_CUTOVER_AT=2026-03-19T00:00:00+09:00` (adjust to your real launch cutoff)
- `PAYAPP_USERID=...`
- `PAYAPP_LINKKEY=...`
- `PAYAPP_LINKVAL=...`
- `PAYAPP_API_URL=https://api.payapp.kr/oapi/apiLoad.html`
- `PAYAPP_RETURN_URL=https://dooext.dooheetv.com/`
- `PAYAPP_FEEDBACK_URL=https://dooext-api.dooheetv.com/api/billing/payapp/feedback`
- `PAYAPP_FAIL_URL=https://dooext-api.dooheetv.com/api/billing/payapp/fail`
- `PAYAPP_REBILL_EXPIRE=2035-12-31T00:00:00+09:00`
- `PAYAPP_REBILL_CYCLE_MONTH=90`

## 4) Endpoints added

- `GET /api/billing/plans`
- `GET /api/billing/status`
- `POST /api/billing/payapp/start`
- `POST /api/billing/payapp/feedback`
- `POST /api/billing/payapp/fail`
- `POST /api/billing/subscription/cancel`

## 5) Plan gates currently enforced server-side

- Convert monthly limit and file size limit (`/api/convert`)
- History usage (`/api/history`, `/api/history/{job_id}`)
- Viewer state save/load (`/api/viewer/{job_id}/viewer-state`)
- TXT/XLSX download (`/api/download/{job_id}/txt`, `/api/download/{job_id}/xlsx`)

## 6) Rollout checklist

1. Set backend env vars (especially PayApp keys and callback URLs).
2. Deploy backend.
3. Deploy frontend.
4. Login with an old account and verify:
   - Billing card says legacy path (no payment required).
   - Existing features still work.
5. Create a new account and verify:
   - Pricing card is shown.
   - `lite/pro` buttons redirect to PayApp.
   - Callback updates billing status after payment.

## 7) Notes

- Billing is off when `DOO_BILLING_ENABLED=false` (safe default).
- Callback idempotency is handled by event hash files under runtime.
- User classification is `user_id` based, not email based.
