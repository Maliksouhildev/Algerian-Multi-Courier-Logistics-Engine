import crypto from 'crypto';

export type PhaseGate =
  | 'PREPARATION'
  | 'IN_TRANSIT'
  | 'DELIVERY_LOOP'
  | 'RETURN_IN_TRANSIT'
  | 'TERMINAL_DELIVERED'
  | 'TERMINAL_RETURNED'
  | 'CANCELLED'
  | 'FAILED_PERMANENTLY';

const PHASE_RANKS: Record<PhaseGate, number> = {
  PREPARATION: 1,
  IN_TRANSIT: 2,
  DELIVERY_LOOP: 3,
  RETURN_IN_TRANSIT: 4,
  TERMINAL_DELIVERED: 5,
  TERMINAL_RETURNED: 5,
  CANCELLED: 5,
  FAILED_PERMANENTLY: 5,
};

/**
 * Evaluates whether a webhook or polling update is allowed to transition a parcel's phase_gate.
 * - Blocks any regression from terminal states (Phase 4 & Phase 5).
 * - Blocks out-of-order regressions to earlier phases (newRank < currentRank).
 * - Allows Phase 4B (RETURN_IN_TRANSIT) to advance ONLY to TERMINAL_DELIVERED (hub rescue) or TERMINAL_RETURNED.
 * - Allows cyclic transitions inside Phase 3 (DELIVERY_LOOP).
 */
export function canTransitionPhase(currentPhase: PhaseGate, targetPhase: PhaseGate): boolean {
  if (
    currentPhase === 'TERMINAL_DELIVERED' ||
    currentPhase === 'TERMINAL_RETURNED' ||
    currentPhase === 'CANCELLED' ||
    currentPhase === 'FAILED_PERMANENTLY'
  ) {
    return false;
  }

  if (currentPhase === 'RETURN_IN_TRANSIT') {
    return (
      targetPhase === 'RETURN_IN_TRANSIT' ||
      targetPhase === 'TERMINAL_DELIVERED' ||
      targetPhase === 'TERMINAL_RETURNED'
    );
  }

  const currentRank = PHASE_RANKS[currentPhase];
  const targetRank = PHASE_RANKS[targetPhase];

  return targetRank >= currentRank;
}

export function computeWebhookDedupHash(
  courierCode: string,
  trackingNumber: string,
  rawStatus: string,
  eventTimestamp: string | number
): string {
  return crypto
    .createHash('sha256')
    .update(`${courierCode}:${trackingNumber}:${rawStatus}:${eventTimestamp}`)
    .digest('hex');
}

export function verifyYalidineHmacSignature(
  rawBody: Buffer | string,
  signatureHeader: string,
  webhookSecret: string
): boolean {
  const computed = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
