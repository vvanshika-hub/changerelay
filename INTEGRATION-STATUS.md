# ChangeRelay verification status

Recorded **30 October 2026**. Current viaSocket skill: **2026-10-30.4**. The installer pointer was refreshed from the official installer exactly; `viasocket-apps` is pinned to **0.14.0**. SDK types and real responses govern the server integration.

## Current delivery and boundaries

**Production:** [changerelay.vercel.app](https://changerelay.vercel.app), on the verified Hobby plan. A cloud Linux build completed. One approved 1 GiB daemon was observed ready, 1/1 alive. Eight protected server environment entries were saved with explicit owner approval. No paid upgrade was made.

**Real owner workflow verified:** hosted sign-in, three owner-scoped Google connections, ownership checks, demo source mapping and saved event details/review persisted across local and hosted origins. Real AI draft assistance produced an immutable live preview for 31 October 2026 at 5 pm IST with notifications off. Auth status was configured, unauthenticated live access returned 401, and private environment/data/source URLs returned 404.

**Not applied by owner choice:** the owner declined the final real reschedule. The event remains 31 October 2026, 14:00–15:00 IST. No Calendar update, Sheet update or Gmail send followed that preview. The complete applied organiser-owned/hosted change-and-announcement journey is therefore **UNTESTED**. This is not a missing viaSocket action.

**Mobile scope:** after the browser viewport override failed, a local frame loaded the actual authenticated site at 390 × 844. Measured width was 390 with page width 375 and no horizontal overflow. Events and immutable Preview were inspected in the DOM and screenshots. Frame interaction was unavailable; a complete phone journey is not verified. Images: `../changerelay-phone-layout.png` and `../changerelay-phone-preview.png`.

**Current release:** the final production refresh is running. Its default-timezone correction and new privacy controls still need a post-release browser check.

## Real calls and evidence

| Scope | Observed result | What it establishes |
| --- | --- | --- |
| Calendar: four selected actions | List calendars/events, get event, update/read-back passed on a real developer test connection. The approved no-guests demo retained its existing schedule and other details; invitation notifications were suppressed. | Individual real calls, not a final applied owner journey. |
| Sheets: six selected actions | Spreadsheet/tab/row lists, stable-ID lookup, row read and RAW update/read-back passed on the approved demo Sheet. The no-op update retained six business fields. Dates were repaired to ISO strings with explicit offsets. | Individual real calls and stable-ID reconciliation. |
| Gmail: three selected actions | An exact approved self-test was sent, searched and read. Subject, sender, recipient and body matched. Later reconciliation made zero additional sends. | Verified self-test delivery; no participant notification or acknowledgement claim. |
| AI | A real strict structured response passed. The actual owner's 31 October 5 pm no-notify request filled a draft and live preview. No action tools were supplied. | Draft assistance, not autonomous approval/execution. |
| Owner onboarding | All three connections belong to the signed-in product owner, separate from developer tests. Mapping, details and saved review survived hosted sign-in. | Ownership and persisted setup across origins. |
| Supabase | Eight real Auth/RLS/private-RPC/concurrent-CAS checks and separate durable session-revocation checks passed. Real-storage recovery used simulated providers. Disposable QA accounts/workspaces were cleaned up. | Storage/auth isolation and recovery; simulated providers are not Google write evidence. |
| Automated checks | 202 tests, 27 frontend contract groups and 16 local PostgreSQL-engine checks passed. Three new callback race checks passed. | Covered logic and UI contracts; not a complete phone journey. |
| Hosted operation | Production served successfully; the independent worker was ready/alive. Owner sign-in and public/private route checks passed. | Actual deployment, authenticated browser access and worker startup. |
| Hosted sample | A recorded conflict warning and approved controlled failure were observed: Calendar verified, Sheet failed, Gmail pending. Recovery result is pending. | Real hosted sample behavior; no Google changes or real email. |
| Privacy and integration management | Guard tests cover clear-data confirmation and active/uncertain-run blocks, fenced pause/resume and reconciliation. Real SDK pause/list/enable/list verification passed on an old developer Gmail test connection, with no owner changes or emails. | Implemented controls and isolated real SDK management calls; owner privacy buttons were not clicked live. |

A real approved Gmail self-test response included the following, with provider identifiers omitted:

```json
{"labelIds":["UNREAD","SENT","INBOX"]}
```

The email was read back independently. Safe evidence summaries are in `database/auth-live-summary.json`, `database/live-verification-summary.json` and `database/gmail-reconciliation-summary.json`. Private connection fixtures and provider credentials are excluded from delivery.

## Every “Finished when” line: app integrations

The current feature page has these seven requirements. Each applicable line is accounted for below.

| Requirement | Decision, implementation and proof |
| --- | --- |
| **Confirmed** | The integration plan table was approved before integration code. The selected personal calendar, no-guests fixture, demo Sheet/tabs and exact self-test email were separately approved. Production environment setup and the one-worker deployment were explicitly approved. The owner declined applying the final real preview; that choice was respected. |
| **Who connects** | The signed-in organiser uses the product's Calendar, Sheets and Gmail Connect buttons. Private connection references are owner-scoped; expiration reconnects in place. The real owner's three connections and ownership checks passed. Developer test identities are not adopted as product-user connections. |
| **Where and when each value comes from** | During mapping, the organiser picks the Calendar event, spreadsheet/tabs, stable row and column meanings. Per run, they choose the new time, announcement inclusion, sender, roster recipients and editable content. Code derives duration, timezone-safe timestamps, current row positions, action versions and receipt markers. AI suggests time/message draft fields only. The field groups below identify emitted inputs; unrelated optional inputs are deliberately omitted. |
| **Who picks the action** | Server code selects the fixed workflow: source reads, Calendar update/read-back, Sheet lookup/update/read-back, then individually approved Gmail send/reconciliation. There is no arbitrary action runner; AI receives no execution tools. |
| **Where it runs** | All app/AI calls use `viasocket-apps` on the backend. The browser receives the approved per-user Connect token and safe UI results. Provider/execution references stay private. Encrypted CAS records and fenced event leases protect saved work. Event subscriptions are not used. |
| **Tested** | All four Calendar, six Sheets and three Gmail actions ran on real developer test connections before the dependent implementation. Actual owner connections, source reads, AI draft, mapping, preview and hosted sign-in passed. **UNTESTED:** a complete applied real owner/hosted reschedule and announcement, because the owner declined that mutation. No subscription/event test applies. |
| **Proof** | Latest official checker: **0 FAIL, 4 WARN over 7 files**. Three warnings concern the real-tested Gmail catalog fallback; the fourth mistakes a literal product Gmail app name for a service slug. Real evidence includes the redacted response above. Automated evidence is 202 tests, 27 frontend contract groups, 16 local database checks and 8 real Supabase checks. |

### Inputs and their suppliers

Resource references here describe private server values, not browser-editable credentials.

| Calls / emitted input fields | Supplier and timing |
| --- | --- |
| Calendar list: `maxResults`, `minAccessRole`, `showDeleted`, `showHidden`; optional `pageToken` | Code sets a bounded writer-only list and visibility policy; provider supplies pagination when used. |
| Event list: `calendarId`, `date_mode`, `relative_days`, `show_deleted`, `show_hidden_invitations`, `maxResults`; optional `search_query` | Organiser picks the calendar; code sets the relative 90-day/250-result window; organiser supplies optional search text. |
| Event read: `calendarId`, `eventId` | The organiser's confirmed mapping, kept privately and reread per preview/execution. |
| Event update: `calendar_id`, `eventId`, `timeZone`, `startdate`, `starttime`, `meeting_duration`, `sendUpdates` | Mapping supplies the resource; fresh source supplies timezone/duration; approved proposed time supplies the start. Code formats values and suppresses invitation updates. |
| Spreadsheet list: `fetch_mode`, optional `search_keyword`/`page_token`, `owner_filter`, `sort_by`, `sort_order`, `max_results` | Code sets bounds/sorting, organiser supplies optional search, provider supplies pagination. |
| Tab list and row list/read: spreadsheet/tab fields, `column_key`, `sorting_limit`, `row_number` | Organiser confirms spreadsheet/tabs; code uses named columns and bounded reads. Row numbers come from fresh stable-ID lookup, never a stale browser position. |
| Stable-ID lookup: spreadsheet/tab fields, `search_filter`, `sorting` | Confirmed event-ID column/value and code's exact basic lookup/duplicate-detection limit. |
| Sheet update: spreadsheet/tab fields, `record`, `column_key`, `valueInputOption`, `column_selected`, `column_name` | Fresh lookup supplies row; mapping supplies start/end columns; approved target supplies values. Code uses RAW and changes only those schedule fields. |
| Gmail send: `to`, `from`, `subject`, `messageBody` | Exact server-saved approval snapshot, originally reviewed by the organiser. Recipients come from the linked roster; fictional addresses are blocked live. |
| Gmail search/read: `search_mode`, `includeReplies`, `query`, `searchFields`, `pagination`, `select_response_fields`, `message_id` | Code builds a bounded search from approved recipient/marker, or reads the privately saved receipt. The browser does not choose a provider message reference. |
| Option pickers: `fieldKey`, `existingFields`, connection selection | Code selects the field; organiser picks visible mapping choices. Verified parent choices and ownership supply dependent values. Expiring opaque choices are reselected rather than guessed. |

## AI verification scope

The AI page has “Verify” rather than a separate “Finished when” list. Thread listing and a real schema-object feature response passed. The product uses a fresh independent thread per draft and synchronous structured output. Chat follow-up/history UI, tool execution and websocket delivery are not product features and are not claimed as verified. AI never supplies credentials, source mappings, recipients or approval.

The budget is 1,500 characters, one request in flight per organiser, four per minute and thirty per day per process. Context excludes the roster and credentials. Shared production-wide quota enforcement remains a launch-hardening item.

## Checker and feedback

The official checker reports **0 FAIL, 4 WARN over 7 files**. Calendar and Sheets resolved. Three warnings concern Gmail's inconsistent documented slug: the implementation uses the uniquely returned exact-name catalog service and its three real actions passed. The fourth is a false positive on the product's literal Gmail app label, not an invented provider reference.

Previously reported to viaSocket:

- Setup OAuth returned `server_error`; private manual server setup was used.
- Gmail slug/documentation resolution differed from the discoverable catalog.
- The fully downloaded AI page lacked the required `END OF PAGE` terminator. The complete response and SDK types were read and the structured request tested; missing fields were not guessed.
- Non-sensitive setup/action/check progress events and documentation feedback were accepted. No private roster/event content or secret was included.

**VIASOCKET-PENDING: none.** No absent app, action, trigger or field blocks this selected workflow.

## Remaining verification and product limits

- Finish the in-progress production refresh and post-release check, including the default timezone and privacy controls. Hosted sample recovery result is pending.
- Phone Events/Preview layout passed inspection at 390 × 844; full phone interaction/recovery remains unverified.
- A full applied real write journey remains untested by the owner's choice. Obtain fresh exact approval before exercising it.
- Clear saved event data, integration pause/resume and a manual Google access-revocation link are implemented. Clearing retains connections/account and requires guarded confirmation with no active/uncertain runs. Owner controls have not been exercised live. No account deletion, automatic provider revocation, duration edits, assignment rescheduling, team sharing, acknowledgement links or reversal is claimed.
- Onboarding resume saves labels only, alongside limited preferences/help. Event details and roster are read-only saved information, not live availability proof.
- The bounded selected Calendar window cannot establish participant/private-calendar availability. Large roster/assignment results are blocked at the read limit.
- Complete production SMTP, shared multi-instance quotas, Supabase advisors/pgTAP and CLI-managed migration history before broad public sign-up. Do not rerun the applied database source snapshot.
- Cross-app operations are not atomic. Safe pre-dispatch stopping does not cancel a provider request already in flight; uncertain delivery remains uncertain.
- Existing connection callbacks cannot silently resume or replace paused flows; three callback race checks passed. A fully distributed first-onboarding claim remains incomplete before broad multi-instance onboarding.
