import assert from 'assert';
import crypto from 'crypto';
import { encryptCredential, decryptCredential } from './crypto/envelope';
import {
  normalizePrimaryMobile,
  normalizeSecondaryPhone,
  formatYalidineAddressWithSecondaryPhone,
} from './normalizers/phone';
import { QuotaThrottler } from './throttler/quota-throttler';
import { canTransitionPhase, computeWebhookDedupHash } from './state-machine/phase-gate';
import {
  buildYalidinePayload,
  parseYalidineBatchResponse,
} from './adapters/yalidine.adapter';
import { buildZrExpressPayload } from './adapters/zrexpress.adapter';
import {
  buildEcotrackCreatePayload,
  buildEcotrackValidationPayload,
} from './adapters/ecotrack.adapter';
import { buildMaystroPayload } from './adapters/maystro.adapter';
import { auditCourierDisbursementBatch } from './ledger/reconciler';
import { NormalizedOrderInput } from './adapters/types';

async function runTests() {
  console.log('=== Running Algerian Multi-Courier Logistics Engine V4 Verification ===\n');

  // 1. Test AES-256-GCM Envelope + AAD Isolation
  const keyHex = crypto.randomBytes(32).toString('hex');
  const ctxTenant1 = { tenantId: 1, courierCode: 'yalidine' };
  const ctxTenant2 = { tenantId: 2, courierCode: 'yalidine' };
  const envelope = encryptCredential('secret-yal-token', keyHex, 1, ctxTenant1);

  assert.match(
    envelope,
    /^v[0-9]+:[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/,
    'Envelope must match PostgreSQL 24-hex IV & 32-hex Auth Tag CHECK constraint'
  );
  assert.strictEqual(
    decryptCredential(envelope, () => keyHex, ctxTenant1),
    'secret-yal-token'
  );
  assert.throws(
    () => decryptCredential(envelope, () => keyHex, ctxTenant2),
    /Unsupported state or unable to authenticate data/,
    'Cross-tenant AAD mismatch must throw authentication error'
  );
  console.log('[PASS] 1. AES-256-GCM Envelope (24-hex IV + 32-hex Tag) & Cross-Tenant AAD Isolation');

  // 2. Test Algerian Phone Normalizer (Mobile 05/06/07, VoIP 09, PSTN Landline 01-04)
  assert.strictEqual(normalizePrimaryMobile('+213 (0) 550 12 34 56'), '0550123456');
  assert.deepStrictEqual(normalizeSecondaryPhone('00213 982 11 22 33'), {
    canonical: '0982112233',
    type: 'VOIP_FIXED',
  });
  assert.deepStrictEqual(normalizeSecondaryPhone('023 12 34 56'), {
    canonical: '023123456',
    type: 'LANDLINE',
  });
  assert.strictEqual(
    formatYalidineAddressWithSecondaryPhone('Hai En-Nour 12', {
      canonical: '023123456',
      type: 'LANDLINE',
    }),
    '[Tel 2: 023123456] - Hai En-Nour 12'
  );
  console.log('[PASS] 2. Algerian Dual-SIM, VoIP (09), & Landline (01-04) Phone Normalizer');

  // 3. Test All 4 Courier Adapters
  const sampleOrder: NormalizedOrderInput = {
    reference: 'ORD-12345',
    customerName: 'Mohamed Benali',
    phonePrimary: '0550123456',
    phoneSecondary: '023123456',
    deliveryAddress: 'Hai En-Nour 12',
    originWilayaName: 'Alger',
    destinationWilayaId: 31,
    destinationWilayaName: 'Oran',
    destinationCommuneId: 1104,
    destinationCommuneName: 'Bir El Djir',
    isStopdesk: false,
    stopdeskId: null,
    productDescription: '1x Veste Cuir Noir (Taille L)',
    totalCodAmount: 4500,
    isFreeShipping: false,
    declaredValue: 0,
    doInsurance: false,
    hasExchange: true,
    productToCollect: 'Ancienne Veste Taille M',
    estimatedWeight: 1.2,
  };

  const yalPayload = buildYalidinePayload(sampleOrder);
  assert.strictEqual(yalPayload.address, '[Tel 2: 023123456] - Hai En-Nour 12');
  assert.strictEqual(yalPayload.length, null);

  const yalParsed = parseYalidineBatchResponse({
    'ORD-12345': {
      success: true,
      order_id: 'ORD-12345',
      tracking: 'yal-998877',
      label: 'https://api.yalidine.app/labels/yal-998877.pdf',
    },
  });
  assert.strictEqual(yalParsed[0].tracking, 'yal-998877');

  const zrPayload = buildZrExpressPayload(sampleOrder);
  assert.strictEqual(zrPayload.Colis[0].TypeColis, 1, 'Exchange must map to TypeColis = 1');

  const ecoCreate = buildEcotrackCreatePayload(sampleOrder);
  assert.strictEqual(ecoCreate.type, 2, 'Exchange must map to Ecotrack type = 2');
  assert.strictEqual(
    ecoCreate.telephone_2,
    '',
    '9-digit landline must not be placed in Ecotrack telephone_2'
  );
  assert.ok(ecoCreate.remarque.includes('Tel 2: 023123456'));
  const ecoValid = buildEcotrackValidationPayload('EC998877');
  assert.strictEqual(ecoValid.tracking, 'EC998877');

  const maystroPayload = buildMaystroPayload(
    sampleOrder,
    'd3b07384-d113-4e6e-8c9c-123456789abc'
  );
  assert.strictEqual(maystroPayload.commune, 1104);
  assert.strictEqual(
    maystroPayload.details[0].product,
    'd3b07384-d113-4e6e-8c9c-123456789abc'
  );
  console.log('[PASS] 3. All 4 Courier Adapters (Yalidine, ZR Express, Ecotrack 2-Step, Maystro)');

  // 4. Test Redis Dynamic Quota Throttler
  const store = new Map<string, string>();
  const mockRedis = {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
      return 'OK';
    },
  };
  const throttler = new QuotaThrottler(mockRedis);
  await throttler.recordResponseHeaders('yalidine', 1, {
    'hour-quota-left': '1000',
    'day-quota-left': '5000',
  });
  assert.strictEqual(await throttler.canExecute('yalidine', 1, 'LOW_BACKGROUND_POLL'), true);

  // Drop hour quota to 15% (150 / 1000)
  await throttler.recordResponseHeaders('yalidine', 1, {
    'hour-quota-left': '150',
  });
  assert.strictEqual(
    await throttler.canExecute('yalidine', 1, 'LOW_BACKGROUND_POLL'),
    false,
    'Background polling must pause when hourly quota < 20%'
  );
  assert.strictEqual(
    await throttler.canExecute('yalidine', 1, 'HIGH_FULFILLMENT'),
    true,
    'Order creation & official label download must remain active'
  );
  console.log('[PASS] 4. Header-Aware Redis Dynamic Quota Throttler');

  // 5. Test Phase-Gated State Machine
  assert.strictEqual(
    canTransitionPhase('DELIVERY_LOOP', 'DELIVERY_LOOP'),
    true,
    'Phase 3 must allow cyclic delivery attempts'
  );
  assert.strictEqual(
    canTransitionPhase('RETURN_IN_TRANSIT', 'TERMINAL_DELIVERED'),
    true,
    'Phase 4B must allow customer hub rescue to Phase 4 (TERMINAL_DELIVERED)'
  );
  assert.strictEqual(
    canTransitionPhase('RETURN_IN_TRANSIT', 'IN_TRANSIT'),
    false,
    'Phase 4B must block out-of-order regression to Phase 2 (IN_TRANSIT)'
  );
  assert.strictEqual(
    canTransitionPhase('TERMINAL_DELIVERED', 'TERMINAL_RETURNED'),
    false,
    'Terminal Phase 4 must be locked'
  );
  assert.strictEqual(
    computeWebhookDedupHash('yalidine', 'yal-123', 'LIVRE', '2026-10-27T19:00:00Z').length,
    64
  );
  console.log('[PASS] 5. Phase-Gated Cyclic State Machine & Monotonic Webhook Guard');

  // 6. Test COD Financial Reconciliation & Discrepancy Gate
  const cleanAudit = auditCourierDisbursementBatch(
    'BATCH-01',
    [
      { parcelId: 1, entryType: 'COD_CREDIT', amount: 4500, idempotencyKey: '1:cod' },
      { parcelId: 1, entryType: 'BASE_DELIVERY_DEBIT', amount: 500, idempotencyKey: '1:del' },
      { parcelId: 1, entryType: 'COD_FEE_DEBIT', amount: 50, idempotencyKey: '1:fee' },
    ],
    3950
  );
  assert.strictEqual(cleanAudit.expectedNetPayoutDzd, 3950);
  assert.strictEqual(cleanAudit.requiresDisputeReview, false);

  const disputedAudit = auditCourierDisbursementBatch(
    'BATCH-02',
    [
      { parcelId: 2, entryType: 'COD_CREDIT', amount: 4500, idempotencyKey: '2:cod' },
      { parcelId: 2, entryType: 'BASE_DELIVERY_DEBIT', amount: 500, idempotencyKey: '2:del' },
    ],
    3750 // 250 DZD missing (> 100 DZD threshold)
  );
  assert.strictEqual(disputedAudit.discrepancyDzd, 250);
  assert.strictEqual(disputedAudit.requiresDisputeReview, true);
  console.log('[PASS] 6. Append-Only COD Financial Ledger & >100 DZD Discrepancy Detector');

  console.log('\nALL 6 CORE SUBSYSTEM SUITES PASSED 100%!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
