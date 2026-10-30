# ChangeRelay

**Live website: [changerelay.vercel.app](https://changerelay.vercel.app)** · [Sign in](https://changerelay.vercel.app/signin) · [Judge demo guide](DEMO-GUIDE.md)

ChangeRelay helps an organiser review an event change across Google Calendar, Google Sheets, participants and recorded volunteer assignments. The organiser approves an exact saved plan before any update. A separate fictional sample demonstrates conflicts and recovery without changing Google accounts or sending email.

## Current delivery

Production is deployed on Vercel Hobby with one explicitly approved 1 GiB background worker, verified ready and running. Eight server environment entries were saved in protected hosting settings with the owner's approval. No paid plan upgrade was made.

The real organiser signed in on the hosted site. All three Google connections, saved event details and the saved review persisted across the local and hosted origins. Connection ownership was checked against the organiser's identity, separate from developer test connections. A real AI-assisted draft for **31 October 2026, 5 pm IST**, with notifications off, produced an immutable live preview.

**The owner declined applying that real reschedule.** The real demo event remains **31 October 2026, 2–3 pm IST**. The preview did not update Calendar, Sheets or Gmail. Earlier isolated real-provider tests prove individual calls, not a complete applied change through the final organiser workspace.

Phone layout was inspected for authenticated Events and immutable Preview at an actual 390 × 844 frame size, with no horizontal overflow. Frame interaction was unavailable, so the complete phone journey is not verified. The final production refresh is in progress; its timezone correction and new controls still need the post-release check.

## What works

1. Confirm an organiser account and sign in. Encrypted HTTP-only cookies are checked with Supabase; logout revocation survives a restart.
2. Connect Calendar, Sheets and Gmail through viaSocket. The server checks connection ownership; expired connections can reconnect in place.
3. Explicitly pick an event, schedule row, tabs and columns. Stable event IDs keep row matching safe after sorting. Saved setup labels help resume onboarding; fresh provider choices must be reselected when required.
4. Propose a new start time in the event's timezone. The original duration is preserved. Optional AI fills a draft only; the normal form works without it.
5. Review before/after times, source changes, recorded conflicts, unavailable checks, exact recipients and message text. Calendar invitation updates are suppressed; Gmail announcements are a separate opt-in choice.
6. Approve the saved version. The worker checks current sources, updates and verifies Calendar, updates and verifies the stable-ID Sheet row, then handles approved individual announcements. Editing or remapping requires a fresh preview.
7. Inspect saved history and recover unfinished work. Verified steps are preserved; uncertain writes are reconciled before another attempt. A stale plan can be safely stopped before any dispatch. Sent and acknowledged are separate states.
8. Privacy controls can pause/resume an integration or clear saved event data while retaining connections/account. Guarded confirmation and checks block clearing during active or uncertain work. A Google account link supports manual access revocation; this is not account deletion.

Event details show saved source information and a read-only saved roster. Preferences cover display timezone and the default announcement choice. Help explains setup and recovery. These screens do not add roster editing, a support chatbot or automatic availability checks.

## Demonstrate it

Use [DEMO-GUIDE.md](DEMO-GUIDE.md) for a short presentation: sample conflict → sample partial failure/recovery → real live preview. Fictional `example.com` recipients are blocked from live sending. Keep notifications off and leave the current real preview unapplied unless the owner separately approves an exact change.

Hosted sample data is temporary and can reset when the server instance changes. Signed-in live workspace data uses encrypted, owner-scoped Supabase storage.

## Run locally

Use **Node.js 24.x**:

```text
npm ci
npm start
```

Open **http://localhost:54880**; account access is `/signin`, and the signed-in workspace is `/workspace`. `.env.example` uses the same port. For a fresh installation, copy it to a private `.env` and supply configuration securely. Never commit or share `.env`, local sessions, connection fixtures or installed dependencies. Keep the encryption key stable across deployments; rotation requires migrating existing encrypted records.

## Verification

```text
npm run check
npm test
npm run test:database
```

Current evidence, recorded 30 October 2026:

- **202 automated tests passed**, plus **27 frontend contract groups**, including three new connection-callback race checks.
- **16 local PostgreSQL-engine checks** and **8 real Supabase Auth/RLS/private-RPC/CAS checks** passed.
- Real account-session tests verified restart persistence and durable logout replay denial.
- A real Supabase success/failure/restart/recovery test used simulated providers and preserved the verified Calendar step.
- All **13 selected Google actions** ran on real viaSocket developer test connections. Calendar/Sheet write tests retained the approved existing schedule. Gmail sent only the approved self-test; later reconciliation made no additional sends.
- Real hosted owner sign-in, three connections, ownership checks, saved mapping/details/review, AI draft and live preview passed. Production served successfully and its independent worker was ready/alive. Unauthenticated live access returned 401; private environment/data/source paths returned 404.
- Hosted sample conflict and controlled failure were observed: Calendar verified, Sheet failed and Gmail pending. The next recovery attempt is awaiting its result. Real SDK pause/resume passed on an old developer test connection without changing owner connections or sending email; owner privacy controls were not exercised live.

The source is native JavaScript. `check` means syntax validation, not TypeScript or ESLint. Mobile evidence covers two inspected layouts, not a complete phone journey. See [INTEGRATION-STATUS.md](INTEGRATION-STATUS.md) for each viaSocket completion requirement and verification boundary.

## Hosting and operating limits

See [deployment/VERCEL.md](deployment/VERCEL.md). The HTTP function serves requests; a separate worker continues saved work. Hobby daemon usage has a hard included quota and stops at the limit rather than charging daemon overages. Remaining allowance is unavailable, so uninterrupted monthly uptime is not promised.

Before broad public sign-up, complete production SMTP setup, shared multi-instance AI/auth quotas, the full Supabase advisors/pgTAP review and CLI-managed migration history. The applied database source snapshot must **not** be rerun as a migration.

Other current limits:

- One owner per workspace; no team invitations or shared roles.
- Timed, one-off, whole-minute Calendar events only; changing duration is not implemented.
- Conflict checks cover the selected Calendar's returned 90-day/250-event window and recorded assignments. Participant/private-calendar availability is not checked.
- Roster/assignment reads must remain below the 100-row limit; larger results are blocked.
- Volunteer assignments are not moved automatically. No acknowledgement links, automatic reversal, automatic Google permission revocation, or account deletion flow is implemented. Clearing saved event data retains connections/account.
- Cross-app writes are not atomic, and external delivery cannot be promised exactly once. Recovery preserves uncertainty rather than claiming success.
- Operational persistence is an encrypted CAS aggregate. Normalized reporting tables are not automatically populated and must not start a second independent execution mechanism.
- Existing connection callbacks cannot silently resume or replace a paused integration. A fully distributed claim for first-time connection onboarding remains a multi-instance hardening task.
