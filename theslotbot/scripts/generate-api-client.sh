#!/usr/bin/env bash
# scripts/generate-api-client.sh
#
# Generates a fully-typed TypeScript API client for the Admin Panel
# from the OpenAPI spec. Dev 3 imports from this client instead of
# writing raw fetch calls.
#
# Run this whenever spec.yaml changes:
#   pnpm generate-api-client
#
# Output: apps/admin/src/api/client.ts
#
# Requires: @hey-api/openapi-ts (installed as a dev dependency)
# Install once: pnpm add -D @hey-api/openapi-ts --filter @theslotbot/admin

set -e

SPEC_PATH="apps/api/openapi/spec.yaml"
OUTPUT_PATH="apps/admin/src/api"

echo "Generating API client from $SPEC_PATH..."

npx @hey-api/openapi-ts \
  --input "$SPEC_PATH" \
  --output "$OUTPUT_PATH" \
  --client fetch \
  --exportSchemas true \
  --exportServices true

echo "✓ API client generated at $OUTPUT_PATH"
echo ""
echo "Import in Admin Panel components:"
echo "  import { BookingsService } from '@/api'"
echo "  const result = await BookingsService.getBookings({ today: true })"
