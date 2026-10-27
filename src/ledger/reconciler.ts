export type LedgerEntryType =
  | 'COD_CREDIT'
  | 'ADJUSTMENT_CREDIT'
  | 'BASE_DELIVERY_DEBIT'
  | 'RETURN_PENALTY_DEBIT'
  | 'COD_FEE_DEBIT'
  | 'WEIGHT_SURCHARGE_DEBIT'
  | 'INSURANCE_DEBIT'
  | 'EXCHANGE_FEE_DEBIT'
  | 'ADJUSTMENT_DEBIT';

export interface LedgerEntry {
  parcelId: number;
  entryType: LedgerEntryType;
  amount: number; // Strictly non-negative (>= 0)
  batchReference?: string;
  idempotencyKey: string;
}

export interface BatchReconciliationAudit {
  batchReference: string;
  expectedNetPayoutDzd: number;
  reportedCourierPayoutDzd: number;
  discrepancyDzd: number;
  requiresDisputeReview: boolean;
}

const CREDIT_TYPES = new Set<LedgerEntryType>(['COD_CREDIT', 'ADJUSTMENT_CREDIT']);

/**
 * Computes net expected remittance from append-only unsigned ledger entries
 * and flags any courier disbursement batch discrepancy exceeding 100 DZD.
 */
export function auditCourierDisbursementBatch(
  batchReference: string,
  entries: LedgerEntry[],
  reportedCourierPayoutDzd: number,
  discrepancyThresholdDzd = 100
): BatchReconciliationAudit {
  let expectedNetPayoutDzd = 0;

  for (const entry of entries) {
    if (entry.amount < 0) {
      throw new Error(`Ledger entry amount must be non-negative: ${entry.idempotencyKey}`);
    }
    if (CREDIT_TYPES.has(entry.entryType)) {
      expectedNetPayoutDzd += entry.amount;
    } else {
      expectedNetPayoutDzd -= entry.amount;
    }
  }

  expectedNetPayoutDzd = Math.round(expectedNetPayoutDzd * 100) / 100;
  const discrepancyDzd =
    Math.round(Math.abs(expectedNetPayoutDzd - reportedCourierPayoutDzd) * 100) / 100;

  return {
    batchReference,
    expectedNetPayoutDzd,
    reportedCourierPayoutDzd,
    discrepancyDzd,
    requiresDisputeReview: discrepancyDzd > discrepancyThresholdDzd,
  };
}
