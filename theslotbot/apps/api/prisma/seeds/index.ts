/**
 * prisma/seeds/index.ts
 *
 * Master seed entrypoint.
 * Run with: pnpm --filter @theslotbot/api db:seed
 * Or directly: npx ts-node prisma/seeds/index.ts
 *
 * Execution order matters — respect foreign key dependencies:
 *   1. Agency admin User (no dependencies)
 *   2. Salon record
 *   3. Salon owner User (depends on Salon)
 *   4. Services (depends on Salon)
 *
 * This script uses the Supabase Auth Admin API to create auth users,
 * then inserts the corresponding rows in our User table.
 *
 * ENVIRONMENT VARIABLES REQUIRED:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (for auth user creation)
 *   DATABASE_URL (for Prisma)
 *   SEED_AGENCY_ADMIN_EMAIL, SEED_AGENCY_ADMIN_PASSWORD
 *   SEED_SALON_OWNER_EMAIL, SEED_SALON_OWNER_PASSWORD
 *   SALON_NAME, SALON_SLUG, WA_BUSINESS_NUMBER, GOOGLE_REVIEW_URL
 *
 * IDEMPOTENCY:
 *   This script uses upsert patterns throughout. It is safe to re-run
 *   without duplicating data. If a Supabase auth user already exists
 *   for a given email, the script logs a warning and continues.
 */

import { PrismaClient, UserRole, SubscriptionStatus } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { seedJayaServices } from './jaya/services';

const prisma = new PrismaClient();

// Supabase Admin client (service role — never expose this key)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function createSupabaseUser(
  email: string,
  password: string,
  displayName: string,
): Promise<string> {
  // Check if user already exists to make seed idempotent
  const { data: existing } = await supabaseAdmin.auth.admin.listUsers();
  const alreadyExists = existing?.users.find((u) => u.email === email);

  if (alreadyExists) {
    console.log(`  ℹ Supabase user already exists: ${email}`);
    return alreadyExists.id;
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // bypass email confirmation for seeded accounts
    user_metadata: { name: displayName },
  });

  if (error || !data.user) {
    throw new Error(`Failed to create Supabase user for ${email}: ${error?.message}`);
  }

  return data.user.id;
}

async function main(): Promise<void> {
  console.log('\n🌱 theslotbot seed starting...\n');

  // ── 1. Agency Admin ──────────────────────────────────────────────────
  console.log('Step 1: Creating agency admin...');

  const agencyAdminEmail = process.env.SEED_AGENCY_ADMIN_EMAIL!;
  const agencyAdminPassword = process.env.SEED_AGENCY_ADMIN_PASSWORD!;

  if (!agencyAdminEmail || agencyAdminPassword === 'change_this_before_seeding') {
    throw new Error(
      'Set SEED_AGENCY_ADMIN_EMAIL and SEED_AGENCY_ADMIN_PASSWORD in .env before seeding.',
    );
  }

  const agencyAdminSupabaseId = await createSupabaseUser(
    agencyAdminEmail,
    agencyAdminPassword,
    'Jagdish Singh',
  );

  await prisma.user.upsert({
    where: { supabaseUserId: agencyAdminSupabaseId },
    update: {},
    create: {
      supabaseUserId: agencyAdminSupabaseId,
      email: agencyAdminEmail,
      name: 'Jagdish Singh',
      role: UserRole.agency_admin,
      isActive: true,
      // salonId is null for agency_admin — cross-salon access
    },
  });

  console.log(`  ✓ Agency admin: ${agencyAdminEmail}`);

  // ── 2. Salon ─────────────────────────────────────────────────────────
  console.log('\nStep 2: Creating salon record...');

  const salonName = process.env.SALON_NAME ?? 'Jaya Premium Salon';
  const salonSlug = process.env.SALON_SLUG ?? 'jaya-premium-salon';
  const waNumber = process.env.WA_BUSINESS_NUMBER!;
  const reviewUrl = process.env.GOOGLE_REVIEW_URL;

  if (!waNumber) {
    throw new Error('WA_BUSINESS_NUMBER is required in .env');
  }

  const salon = await prisma.salon.upsert({
    where: { slug: salonSlug },
    update: {
      name: salonName,
      whatsappNumber: waNumber,
      googleReviewUrl: reviewUrl,
    },
    create: {
      name: salonName,
      slug: salonSlug,
      whatsappNumber: waNumber,
      googleReviewUrl: reviewUrl,
      subscriptionStatus: SubscriptionStatus.active,
      // campaignResumeAfter: null means all customers are eligible.
      // If you're seeding after a previous instance, set this to NOW()
      // to prevent blasting customers from before this deployment.
    },
  });

  console.log(`  ✓ Salon: ${salon.name} (id: ${salon.id})`);

  // ── 3. Salon Owner ────────────────────────────────────────────────────
  console.log('\nStep 3: Creating salon owner account...');

  const ownerEmail = process.env.SEED_SALON_OWNER_EMAIL!;
  const ownerPassword = process.env.SEED_SALON_OWNER_PASSWORD!;

  if (!ownerEmail || ownerPassword === 'change_this_before_seeding') {
    throw new Error(
      'Set SEED_SALON_OWNER_EMAIL and SEED_SALON_OWNER_PASSWORD in .env before seeding.',
    );
  }

  const ownerSupabaseId = await createSupabaseUser(
    ownerEmail,
    ownerPassword,
    'Salon Owner',
  );

  await prisma.user.upsert({
    where: { supabaseUserId: ownerSupabaseId },
    update: {},
    create: {
      supabaseUserId: ownerSupabaseId,
      email: ownerEmail,
      name: 'Salon Owner',
      role: UserRole.salon_owner,
      isActive: true,
      salonId: salon.id,
    },
  });

  console.log(`  ✓ Salon owner: ${ownerEmail}`);

  // ── 4. Services ───────────────────────────────────────────────────────
  console.log('\nStep 4: Seeding services...');
  await seedJayaServices(prisma, salon.id);

  // ── Done ──────────────────────────────────────────────────────────────
  console.log('\n✅ Seed complete.\n');
  console.log('Next steps:');
  console.log('  1. Log in at the admin panel with the salon owner credentials above.');
  console.log('  2. Invite salon staff from the Users page.');
  console.log('  3. Submit WhatsApp message templates to Meta.');
  console.log('  4. Test the full booking flow on staging before go-live.\n');
}

main()
  .catch((e) => {
    console.error('\n❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
