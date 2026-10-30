# ChangeRelay on Vercel

**Production: [changerelay.vercel.app](https://changerelay.vercel.app)**

A cloud Linux production build completed on the verified **Hobby** plan with Node.js **24.x**. Eight server environment entries were saved in protected settings with explicit owner approval. One explicitly approved **1 GiB worker** was observed **ready, 1/1 alive**. No paid upgrade was made.

Hosted owner sign-in passed. Three existing Google connections, saved event details and the saved review persisted across local/hosted origins. Configured auth, unauthenticated live 401 responses and private environment/data/source 404 responses were verified. The owner declined applying the real reschedule: hosting success does not establish a complete real write journey. See [integration status](../INTEGRATION-STATUS.md).

The final production refresh is running with a default-workspace-timezone correction and privacy controls; their post-release browser check is pending. Authenticated Events/Preview phone layouts were inspected in a measured 390 × 844 frame with no horizontal overflow. A complete phone journey remains unverified because frame interaction was unavailable.

## Deployed components

| Component | Entry point | Behavior |
| --- | --- | --- |
| HTTP function | `api/index.mjs` | Awaits the Node handler; opens no port and starts no interval worker. |
| Independent worker | `daemon.mjs`, `Dockerfile.worker` | Continues durable work without public inbound HTTP; one minimum-size instance. |
| Assets | `public/`, viaSocket browser SDK | Explicitly bundled; only the public URL allowlist is served. |
| Sample data | Temporary function directory | Clearly labeled temporary; progress can reset across instances. |
| Live data | Supabase | Encrypted owner-scoped mappings, previews, approvals, history, leases, receipts and logout revocations. |

The manifest, lockfile and worker image target Node 24. The HTTP function uses Fluid compute and a 300-second maximum. Its bounded adapter handles raw streams and Vercel's lazy parsed-body getter; malformed JSON returns a safe 400. The function does not rely on its lifetime to keep a polling worker running.

The worker keeps its own lifetime referenced, stops new cycles on shutdown and waits up to 25 seconds inside the platform's 30-second grace period. Supabase/Auth calls have 15-second transport deadlines; viaSocket calls have 30-second deadlines. Interrupted operations are reconciled from durable state. A timeout is not proof of failure.

## Hobby quota and uptime

Hobby currently includes **5 Active CPU-hours and 420 GB-hours of Provisioned Memory per month** for daemons, shared across the team's projects. Waiting consumes memory quota. At 1 GiB, 420 GB-hours permits at most about **17.5 days** of continuous uptime before other usage, not a full always-on month.

Hobby daemon use is not billed beyond that allowance: daemons stop at either cap until the next month or a manual upgrade. No automatic upgrade was selected. **Remaining allowance is unavailable**, not assumed unused. Monitor usage charts before promising uninterrupted operation.

Daemons are Public Beta, production-only and have no persistent local filesystem. They accept no public HTTP/TCP traffic. Hobby's daily Cron cannot replace near-immediate recovery polling.

## Configuration and private files

The eight production environment names are `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_SESSION_KEY`, `APP_URL`, `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID` and `VIASOCKET_EMBED_SECRET`. No values belong in these docs, source files or browser code. Keep the encryption key stable; rotation requires migrating encrypted records.

The empty `deployment/static` output prevents publishing the source directory. `.vercelignore`, `.dockerignore` and function exclusions omit private environment/session/test data, including hidden files. The worker installs production dependencies and copies runtime sources without copying `.env` or local data.

The Windows filesystem tracer has an ignore-pattern normalization issue: an in-place trace included existing local data despite the intended patterns. **Continue using clean source staging and remote Linux builds. Do not upload unchecked Windows prebuilt output.** Inspect actual artifacts for private files before future releases.

Cloud source deployment builds the Dockerfile/image remotely. Local Docker is only needed for local image tests and is not installed here. During the current beta, keep the project's root directory at the uploaded app root rather than a repository subfolder.

## Verification and future releases

Vercel CLI **65.8.0** accepted the configuration. Local checks found the public assets and browser SDK. The latest full suite passed **202/202**, with **27 frontend contract groups** in addition. Three new callback race checks passed. Deployment checks cover parsing, auth boundaries, safe asset paths, sample labeling, exclusions, Node alignment, worker lifetime and bounded shutdown. The cloud production build and worker startup succeeded. Hosted sample conflict/controlled failure was observed; recovery confirmation is pending.

Before a future release:

1. Reconfirm the intended project, Hobby plan and environment; never silently upgrade it.
2. Run `npm run check`, `npm test` and applicable database checks.
3. Use clean source, stable server keys and the correct HTTPS origin. Keep preview credentials separate from production.
4. Inspect the build and worker state. Test hosted sign-in, logout, mapping reload and a read-only preview.
5. Exercise a real mutation only after approval of its exact event/time/recipient/message plan. Current demonstration permission is preview-only.

Production SMTP, shared multi-instance AI/auth quotas, a fully distributed first-connection onboarding claim, database advisors/pgTAP and CLI migration history remain broad-launch hardening tasks. The applied source snapshot must not be rerun. Privacy controls clear event data while retaining connections/account, pause/resume integrations and link to manual Google access revocation. Guard tests pass and isolated developer SDK pause/resume passed; real owner controls were not clicked. Account deletion is not implemented.

## Official references

- [Node.js Functions and request bodies](https://vercel.com/docs/functions/runtimes/node-js)
- [Supported Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Daemons](https://vercel.com/docs/daemons), [configuration](https://vercel.com/docs/daemons/config-reference), [quotas](https://vercel.com/docs/daemons/limits)

Reviewed 30 October 2026. Recheck limits before changing the plan or worker size.
