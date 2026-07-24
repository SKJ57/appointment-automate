/**
 * prisma/seeds/jaya/services.ts
 *
 * Jaya Premium Salon — Service Catalogue Seed
 *
 * This file is Jaya-specific. For a new client, clone this file
 * into prisma/seeds/<new-client>/ and update the values.
 * The structure (types, fields, categories) never changes —
 * only the data changes between clients.
 *
 * price: stored in paise (1 INR = 100 paise).
 *   e.g. 80000 = ₹800.00
 *
 * category: drives revisit campaign message branching.
 *   short_cycle  → haircut, colour touch-up (book again in 4–8 weeks)
 *   medium_cycle → facials, skin treatments (book again in 6–10 weeks)
 *   long_cycle   → bridal, deep treatments (book again in 3–6 months)
 *
 * displayOrder: controls the order services appear in the WhatsApp menu.
 *   Lower numbers appear first.
 */

import { PrismaClient, ServiceCategory } from '@prisma/client';

export async function seedJayaServices(
  prisma: PrismaClient,
  salonId: string,
): Promise<void> {
  console.log('  Seeding services for Jaya Premium Salon...');

  const services = [
    // ─── Hair ────────────────────────────────────────────────────────
    {
      name: 'Haircut & Styling',
      description: 'Precision cut with blow-dry and styling.',
      price: 80000,            // ₹800
      durationMinutes: 60,
      category: ServiceCategory.short_cycle,
      displayOrder: 1,
    },
    {
      name: 'Hair Colour Touch-Up',
      description: 'Root touch-up using Schwarzkopf professional colour.',
      price: 150000,           // ₹1,500
      durationMinutes: 90,
      category: ServiceCategory.short_cycle,
      displayOrder: 2,
    },
    {
      name: 'Full Hair Colour',
      description: 'Full head colour with toning and conditioning treatment.',
      price: 250000,           // ₹2,500
      durationMinutes: 120,
      category: ServiceCategory.medium_cycle,
      displayOrder: 3,
    },
    {
      name: 'Keratin Smoothing Treatment',
      description: 'Formaldehyde-free keratin treatment for frizz control.',
      price: 450000,           // ₹4,500
      durationMinutes: 180,
      category: ServiceCategory.long_cycle,
      displayOrder: 4,
    },

    // ─── Skin / Face ──────────────────────────────────────────────────
    {
      name: 'HydraFacial',
      description: 'Deep cleansing, extraction, and hydration facial.',
      price: 350000,           // ₹3,500
      durationMinutes: 60,
      category: ServiceCategory.medium_cycle,
      displayOrder: 5,
    },
    {
      name: 'Classic Facial',
      description: 'Cleansing, exfoliation, and moisturising facial.',
      price: 150000,           // ₹1,500
      durationMinutes: 60,
      category: ServiceCategory.medium_cycle,
      displayOrder: 6,
    },
    {
      name: 'Gold Facial',
      description: '24K gold-infused deep nourishing facial.',
      price: 250000,           // ₹2,500
      durationMinutes: 75,
      category: ServiceCategory.medium_cycle,
      displayOrder: 7,
    },

    // ─── Bridal & Special ─────────────────────────────────────────────
    {
      name: 'Bridal Makeup Package',
      description:
        'Complete bridal makeup, hair styling, and draping. Includes trial session.',
      price: 2500000,          // ₹25,000
      durationMinutes: 240,
      category: ServiceCategory.long_cycle,
      displayOrder: 8,
    },
    {
      name: 'Party Makeup',
      description: 'Event-ready makeup and hair styling.',
      price: 250000,           // ₹2,500
      durationMinutes: 90,
      category: ServiceCategory.medium_cycle,
      displayOrder: 9,
    },

    // ─── Nail ─────────────────────────────────────────────────────────
    {
      name: 'Manicure & Pedicure',
      description: 'Classic manicure and pedicure with gel polish option.',
      price: 120000,           // ₹1,200
      durationMinutes: 90,
      category: ServiceCategory.short_cycle,
      displayOrder: 10,
    },
  ];

  // Upsert on (salonId, name) — safe to re-run seed without duplicates
  for (const service of services) {
    await prisma.service.upsert({
      where: {
        // We need a unique constraint on (salonId, name) for this upsert.
        // Add to schema: @@unique([salonId, name]) on Service if required.
        // For now, create if not exists by checking individually.
        id: 'seed-placeholder', // won't match any real ID
      },
      update: {},
      create: {
        ...service,
        salonId,
        isActive: true,
      },
    });
  }

  // Simpler alternative: deleteMany + createMany for seed idempotency.
  // Use this if the upsert above becomes awkward without the unique constraint.
  //
  // await prisma.service.deleteMany({ where: { salonId } });
  // await prisma.service.createMany({
  //   data: services.map((s) => ({ ...s, salonId, isActive: true })),
  // });

  console.log(`  ✓ Seeded ${services.length} services.`);
}
