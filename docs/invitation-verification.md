# Invitation verification

Verification date: 2026-10-15.

## Repeatable regression checks

Run from the workspace root:

```sh
pnpm run test:invitations
pnpm run typecheck
```

The invitation command runs both frontend return-state suites and the member
and team API suites (17 passing tests including nested tests). It requires the
development database and the configured Clerk environment for the mounted API
test. API fixtures are isolated and cleaned up or rolled back; email requests
in the member API suite are stubbed, not sent.

Covered:

- Tab-scoped invitation state, replacing an older invitation, distinct member
  and staff storage keys, encoded tokens and root/prefixed deployment paths.
- Sign-in/sign-up return URL selection, preservation on failed acceptance,
  clearing after successful acceptance or deliberate exit.
- Staff fallback returns to the invitation before opening the root,
  dashboard, onboarding or other operational pages. Clerk callback and
  email-verification subroutes are not interrupted.
- Verified invited email, wrong/unverified-email rejection, exact
  organization/studio/role assignment, expiry and one-use acceptance.
- The **actual API mount**, not only the isolated team handler, allows a new
  invitee without a staff row to reach acceptance. Listing/creation and other
  verbs still pass through the normal team guard.

These regression tests do not automate an external identity provider.

## Development browser evidence

One persistent browser tester exercised both journeys against the real
development API with unique disposable fixtures. Authentication was
programmatic Clerk login, not interaction with the external provider.

| Check | Team | Members |
| --- | --- | --- |
| Signed-out invitation reaches sign-in | Passed, after explicit auth-entry click | Passed, automatic redirect |
| Switch to sign-up in same tab retains invitation | Passed | Passed |
| Restored identity has the invited verified primary email | Passed | Passed |
| Callback fallback reaches explicit invitation, before any access is granted | Passed for root and onboarding | Passed for membership connection page |
| Explicit acceptance reaches real API successfully | Passed | Passed |
| Exact invited studio after acceptance and reload | Passed, including role | Passed, including exact member |
| Pending token cleared only on success | Passed | Passed |
| Same email in another studio remains unlinked | Not applicable | Passed |

The first team browser run exposed a 403 from a team-module guard before the
acceptance handler: a new invitee had no staff organization yet. The narrow
acceptance route now runs before that guard, with the handler's own
authentication, verified-email and token checks intact. A targeted continuation
confirmed acceptance and reload after the fix.

Both browser fixture organizations and their related records were removed.
No existing business data was modified and no invitation email was sent.
The member-home endpoint is `/api/member/me`.

## Published environment: separate, read-only smoke check

The published URL was obtained from deployment metadata:
`https://fitness-hub-portal-weist1.replit.app`.

The published build predates these fork changes. No deployment was performed.

| URL | Result |
| --- | --- |
| `/sign-in` | Actual Clerk sign-in form loaded; no fatal auth/proxy error |
| `/fiudia-members/sign-in` | Actual Clerk sign-in form loaded; no fatal auth/proxy error |
| `/invite/e2e-nonexistent-link` | Invitation entry rendered; auth-entry click reached sign-in and retained token in the tab |
| `/fiudia-members/invite/e2e-nonexistent-link` | Reached member sign-in with invitation-return copy and tab-scoped token |

No production users or fixture records were created, no production database
was accessed, no invitation was accepted and no email or OAuth flow was started.
These results establish public auth-entry availability only.

## Still required for the complete original acceptance criteria

1. A real external OAuth round trip for sign-in and sign-up, including any
   verification/continuation screens, in development. Programmatic login and
   manual fallback navigation are not evidence of this provider flow.
2. After the fixed code is merged and available in a release, the full
   invitation journey in the published environment using explicitly designated
   test users/studios, independently from development users.
3. Actual sign-up/email confirmation and OAuth return, explicit acceptance,
   exact target studio/role or membership, and persistence after reload in that
   published release. Obtain authorization for production test fixtures and
   cleanup before creating or accepting live invitations.

Until those checks are possible, the original task's complete development
and production provider-flow verification is **not complete**.

## Agreed delivery scope

The user approved closing the corrections and completed development checks,
with the remaining real OAuth, email-confirmation and published-release
verification continued as a separate follow-up. This delivery therefore does
not claim that the original provider-flow checks have passed.
