# PHATT ID: self-service password recovery (design note)

Status: **draft, awaiting Brandon's approval. Nothing here is live.**
Issue: PHA-5020. Related: `docs/OWNER-RECOVERY.md` (Homestead owner break-glass, a different thing).

## Problem
The PHATT ID login page (auth.phatt.vip, Authentik) has no "forgot password" link. A member who loses a password has no path except asking the owner. Homestead's break-glass only covers the owner.

## Requirements
1. Link goes to the member's **verified email**.
2. Requests are **rate-limited**.
3. Responses **never reveal whether an account exists**.
4. The flow **ends with a password change** (and a login, so the member lands signed in).

## Design: Authentik recovery flow
Built from stock Authentik stages. No custom code.

Flow `phatt-recovery` (designation: Recovery), stages in order:

| # | Stage | Settings that matter |
|---|-------|----------------------|
| 1 | Identification | user fields: email + username; `pretend_user_exists = true`; no "sources" shown; no password field |
| 2 | Email | `use_global_settings`; token expiry 15 min (single use); template says "if an account matches, here is your link"; `activate_user_on_success = false` |
| 3 | Prompt (new password) | password + repeat, validated by the existing password policy |
| 4 | User write | writes password to the pending user |
| 5 | User login | signs in; session cookie only |

Attach the flow to the Identification stage of the main login flow (`recovery_flow`), which is what makes Authentik render "Forgot password?" on the login page. That is the "link on the page" with no theme edits.

### Requirement mapping
- **Verified email.** Mail goes only to the address on the user object. Users without an email get nothing, silently. Pre-flight: list members with empty email and fix them before go-live.
- **Rate limiting (two layers).**
  - Authentik: a Reputation policy bound to the Identification stage (score drops per failed/blank lookup per IP + username; block under threshold).
  - Edge: SWAG `limit_req` on `/if/flow/phatt-recovery/` and the flow executor API (e.g. 5 req/min/IP, burst 5). Edge limit is the reliable one; verify the Reputation policy behaves as expected on the installed version.
- **No account enumeration.** `pretend_user_exists` makes stage 1 advance identically for unknown names. The Email stage then no-ops for the fake user. Same page, same copy. The remaining leak is **timing** (real path sends mail); test below measures it. Mitigation if measurable: queue mail asynchronously (Authentik already does via worker).
- **Ends in password change.** Stages 3-4. Token is single-use and expires.

### Failure modes and invariants
- Depends on working SMTP from Authentik. If mail is down the member sees success and gets nothing. Add a check that Authentik's mail test succeeds and an alert on worker mail failures.
- Recovery must not bypass MFA. If members have TOTP/WebAuthn, add an authenticator-validate stage after stage 2 (or document that email possession = full recovery, which is weaker). **Decision for Brandon.**
- Admins/`admins` group: Homestead derives `is_admin` from that group. Recovery for admin accounts has the same email-only strength. Option: exclude the `admins` group from the flow via policy binding and keep them on break-glass. **Decision for Brandon.**
- Password reset should invalidate existing sessions/tokens (user write + `session` cleanup). Verify.
- Export the flow as a blueprint (YAML) into git so it is reproducible and reviewable instead of hand-clicked.

## Rollout plan (after approval)
1. Export current default login + any existing recovery flow as a backup blueprint.
2. Apply `phatt-recovery` blueprint; attach to login Identification stage.
3. Edge rate limit in SWAG.
4. Test with a throwaway user (`zz-recovery-test`, a mailbox I can read), then delete it.

## Test plan (the day-one breaker)
Evidence to attach: screenshot of the link on the login page, the email arriving, reset completing, login with new password.
Breakers:
- Unknown username vs real username: compare response body and timing over ~50 requests each.
- 10 requests in a minute: confirm throttled.
- Reuse the link after success: must fail. Use after expiry: must fail.
- Account with no email: no mail, same page.
- Account with MFA: behaves per decision above.

## Open decisions for Brandon
1. MFA on recovery: require second factor, or accept email-only?
2. Exclude `admins` from self-service recovery?
3. Token lifetime 15 min OK?
4. Okay to apply to production Authentik, and which mailbox for the throwaway account?
