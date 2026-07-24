# New Client Setup Runbook

Estimated time: 2–3 hours for a prepared developer.

## Prerequisites

- Access to the theslotbot GitHub organisation (to fork/clone the repo)
- Railway account with a project created for the new client
- Supabase account with a new project created for the new client
- Upstash Redis account with a new database created
- AiSensy account verified for the client's WhatsApp Business number
- Meta Developer Console access to submit message templates

---

## Step 1: Clone and configure the repository

```bash
# Option A: Clone to a new directory (separate deployment)
git clone https://github.com/theslotbot/theslotbot.git theslotbot-<client-slug>
cd theslotbot-<client-slug>

# Option B: Create a new Railway project from the same repo
# (one repo, multiple Railway services — each with their own env vars)
# This is the recommended approach for easy updates.
```

---

## Step 2: Update client.config.ts

Open `apps/api/src/config/client.config.ts`.

The only values you need to change are pulled from environment variables.
You do NOT edit the config file directly — set the environment variables below.

---

## Step 3: Create the client seed data

```bash
# Copy the Jaya seed files as a starting point
cp -r apps/api/prisma/seeds/jaya apps/api/prisma/seeds/<client-slug>
```

Edit the new seed files:

1. `services.ts` — replace with the new client's service menu, pricing,
   durations, and categories. Every value in this file is client-specific.

2. `index.ts` — update the import path to point to the new client's
   services file. Update the hardcoded name strings for the agency admin
   and salon owner.

---

## Step 4: Set environment variables

In Railway (or your hosting platform), set all variables from `.env.example`.

Critical variables that differ per client:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string |
| `DIRECT_URL` | Supabase → Project Settings → Database → Direct connection |
| `REDIS_URL` | Upstash → Database → REST URL (use ioredis format) |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API → anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → service_role key |
| `WA_BUSINESS_NUMBER` | AiSensy → verified phone number in E.164 |
| `AISENSY_API_KEY` | AiSensy → Developer → API Key |
| `META_APP_SECRET` | Meta Developer Console → App → Basic Settings → App Secret |
| `META_WEBHOOK_VERIFY_TOKEN` | Generate: `openssl rand -hex 20` |
| `SALON_NAME` | The salon's display name |
| `SALON_SLUG` | URL-safe version, e.g. `luxe-hair-studio` |
| `SALON_TIMEZONE` | IANA string, e.g. `Asia/Kolkata` |
| `GOOGLE_REVIEW_URL` | Google Business Profile → Get More Reviews |
| `SEED_AGENCY_ADMIN_EMAIL` | `jagdish@theslotbot.com` (same across clients) |
| `SEED_SALON_OWNER_EMAIL` | The new salon owner's email |
| `SEED_SALON_OWNER_PASSWORD` | Temporary password — owner must change on first login |

---

## Step 5: Run migrations and seed

```bash
# Run all pending migrations on the new client's database
pnpm db:migrate

# Create the Salon record, agency admin, salon owner, and services
pnpm db:seed
```

Verify the seed ran correctly:
```bash
pnpm db:studio
# Open the Prisma Studio UI and confirm:
# - 1 row in salons
# - 2 rows in users (agency_admin + salon_owner)
# - N rows in services matching the new client's menu
```

---

## Step 6: Submit WhatsApp message templates to Meta

Templates must be approved before go-live. Approval takes 3–14 days.
**Submit these as early as possible — ideally during Week 2 of development.**

Templates to submit:

| Template name | Category | When sent |
|---|---|---|
| `booking_confirmation` | utility | Booking confirmed |
| `reminder_24h` | utility | 24 hours before appointment |
| `reminder_3h` | utility | 3 hours before appointment |
| `review_request` | marketing | After visit marked complete |
| `revisit_day30_short` | marketing | Day 30, short-cycle services |
| `revisit_day30_medium` | marketing | Day 30, medium-cycle services |
| `revisit_day30_long` | marketing | Day 30, long-cycle services |
| `revisit_day37_short` | marketing | Day 37, short-cycle services |
| `revisit_day37_medium` | marketing | Day 37, medium-cycle services |
| `revisit_day37_long` | marketing | Day 37, long-cycle services |

Template text is in `apps/api/prisma/seeds/<client-slug>/templates.ts`.
Customise before submission.

---

## Step 7: Configure the Meta webhook

In Meta Developer Console → WhatsApp → Configuration → Webhooks:

- Webhook URL: `https://<your-railway-url>/api/webhook/whatsapp`
- Verify Token: the value of `META_WEBHOOK_VERIFY_TOKEN` in your env

Subscribe to: `messages`

---

## Step 8: Invite salon staff

1. Log in to the admin panel as `SEED_SALON_OWNER_EMAIL`.
2. Navigate to Users → Invite Staff.
3. Enter each staff member's email and send the invite.
4. Staff members accept via the emailed link and set their own password.

---

## Step 9: Staging end-to-end test

Before going live, run a full flow on staging:

1. Send a WhatsApp message to the **staging** number (not the live number).
2. Complete a full booking: service → slot → confirm.
3. In the admin panel, mark the booking complete.
4. Verify the review request message fires after `review.requestDelayHours`.
5. Manually trigger the Day 30 campaign query and verify the message sends.
6. Test the kill switch: set `subscriptionStatus = suspended` in the DB
   directly, send a message, verify the offline message fires once and
   subsequent messages are silently dropped within 24 hours.

---

## Step 10: Go live checklist

- [ ] All Meta templates approved (not pending or rejected)
- [ ] Staging end-to-end test passed
- [ ] Mobile browser test on admin panel (physical device, not devtools)
- [ ] BetterStack uptime check configured for the production URL
- [ ] `DRY_RUN_MESSAGES=false` in production env (double-check)
- [ ] `DISABLE_CAMPAIGN_SENDS=false` in production env
- [ ] Salon owner has changed their seeded password
- [ ] `SEED_SALON_OWNER_PASSWORD` removed from production env after seed

---

## Time to deploy for Client 2

Once Client 1 (Jaya) is stable, deploying for Client 2 takes:
- 30 min: new Supabase + Redis + Railway project setup
- 45 min: service menu and template copy/edit
- 30 min: env vars and migration run
- 60 min: template submission (then 3–14 day wait)
- 90 min: staging test

Total active time: ~3 hours. Template approval is the only blocker.
