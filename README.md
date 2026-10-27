# Algerian Multi-Courier Logistics Engine (V4 — Final Production Blueprint)

A battle-tested, multi-tenant logistics orchestration and COD financial clearing engine purpose-built for **Algerian e-commerce**. Natively supports **Yalidine Express**, **ZR Express (Procolis)**, **Maystro Delivery**, and **80+ regional couriers powered by Ecotrack** (DHD, Conexlog, Anderson, World Express, RB Express, etc.).

---

## Repository Structure

```text
├── README.md                          # Complete V4 Master Engineering Specification & Owner's Guide
├── .env.example                       # Environment template
├── postman/
│   └── Algerian_Multi_Courier_Engine.postman_collection.json  # Ready-to-import Postman Collection
├── sql/
│   └── 001_schema_v4.sql              # Consolidated, Zero-Patch PostgreSQL DDL
└── src/
    ├── verify.ts                      # Automated 6-Suite Verification Runner (npm test)
    ├── sandbox-server.ts              # Local HTTP Sandbox Server for Postman (http://localhost:4000)
    ├── crypto/
    │   └── envelope.ts                # AES-256-GCM (12-byte IV + 16-byte Tag + Tenant AAD)
    ├── normalizers/
    │   └── phone.ts                   # Algerian Mobile (05/06/07), VoIP (09), & PSTN Landline (01-04)
    ├── throttler/
    │   └── quota-throttler.ts         # Header-aware Redis Quota Throttler with auto-healing TTLs
    ├── state-machine/
    │   └── phase-gate.ts              # Phase-Gated Cyclic State Machine & Webhook Idempotency
    ├── adapters/
    │   ├── types.ts                   # Unified Courier Adapter Contract
    │   ├── yalidine.adapter.ts        # Yalidine v1 Adapter (Keyed-Object Batch Normalizer)
    │   ├── zrexpress.adapter.ts       # ZR Express / Procolis Adapter
    │   ├── ecotrack.adapter.ts        # Universal Ecotrack 2-Step Adapter (/create + /valid + Dead-Letter)
    │   └── maystro.adapter.ts         # Maystro Delivery Adapter (Stop-Desk Commune & Product UUID)
    └── ledger/
        └── reconciler.ts              # Append-Only COD Financial Clearing & Discrepancy Engine
```

---

## Why This Architecture Exists (The 8 Algerian Logistics Traps Solved)

1. **Oued Smar Optical Sorter Rejection (Hybrid Thermal Label Engine):**
   * Yalidine and Maystro automated sorting hubs use high-speed optical cameras reading proprietary 2D `Datamatrix` codes printed on their official PDFs. Printing a generic third-party `Code-128` label causes manual sorting rejection.
   * **Solution:** For Yalidine & Maystro, a delayed job fetches the official `label_url` 4s after parcel creation and crops it to `100mm x 100mm`. For ZR Express & Ecotrack, labels are rendered locally via `pdfkit` once `is_validated_by_courier = TRUE`.
2. **Ecotrack Two-Step Draft Trap (`/create/order` + `/valid/order`):**
   * On 80+ Ecotrack couriers, `/api/v1/create/order` only creates an unvalidated draft (`Non validé`). If a driver scans a draft label, their terminal rejects it.
   * **Solution:** `shipping_parcels.is_validated_by_courier` starts as `FALSE` and blocks `pdfkit` label generation until Step B (`/api/v1/valid/order`) returns HTTP 200. If Step B fails 5 retries, a dead-letter handler marks the parcel `FAILED_PERMANENTLY`, unlocks the order for re-dispatch, and queues `/api/v1/delete/order`.
3. **Network Timeouts & Ghost Parcels (30s / 120s Verification Gate):**
   * When a `POST` times out (`504`/`ECONNABORTED`), retrying immediately creates duplicate shipments.
   * **Solution:** Row-level locks (`SELECT ... FOR UPDATE`) + a 90s Zombie Watchdog + a 30s/120s delayed search-by-reference recovery job (and `DISPATCH_MANUAL_RECONCILIATION_REQUIRED` for Procolis where search-by-reference is unsupported).
4. **Re-Shipping Returned or Cancelled Orders (`idx_one_active_parcel_per_order`):**
   * A naive `UNIQUE(order_id)` crashes PostgreSQL whenever a returned parcel is re-shipped or an agent cancels ZR Express to switch to Yalidine.
   * **Solution:** A partial unique index `WHERE phase_gate NOT IN ('TERMINAL_RETURNED', 'CANCELLED', 'FAILED_PERMANENTLY')`.
5. **58 vs. 69 Wilayas, Commune Spelling Drift & Decoupled Stop-Desks:**
   * Couriers spell communes differently, Yalidine requires exact French Wilaya strings (`"Aïn Defla"`), and Maystro requires internal integer Commune IDs (`1104`).
   * **Solution:** `courier_commune_mappings` and `courier_stopdesks` store courier-native Wilaya names, Commune names, and Commune IDs while allowing Stop-Desk selection across the entire Wilaya (`commune_id NULL` when `is_stopdesk = TRUE`).
6. **Courier Return Loss (3%–8%) & Hub Rescues (`Phase 4B` vs `Phase 5`):**
   * Locking a parcel at `RETOUR_EN_COURS` (`Phase 4B`) prevents tracking whether the box actually returned to the seller (`RETOURNE_AU_VENDEUR` — `Phase 5`) or was bought at the last minute by the customer at the hub (`LIVRE` — `Phase 4`).
   * **Solution:** `Phase 4B` remains unlocked for forward transitions to `Phase 4` or `Phase 5`, and return penalties are strictly debited only upon entering `Phase 5`.
7. **API Quota Exhaustion & Overnight Deadlocks (Redis Quota Throttler):**
   * Yalidine enforces strict sliding-window rate limits (`hour-quota-left`, `day-quota-left`).
   * **Solution:** Redis keys track remaining quota and rolling window peaks with auto-expiring TTLs (`EX 60`, `EX 3600`, `EX 86400`). Below 20% hourly or 10% daily quota, background tracking polls pause while Order Creation and Label Downloads remain active.
8. **Append-Only COD Financial Clearing Ledger:**
   * Couriers deduct Base Fees, Return Penalties, COD Collection Fees (`1%–1.5%`), Weight Surcharges (`>5kg`), Insurance (`1%`), and Exchange Fees.
   * **Solution:** An append-only ledger (`amount >= 0`, `idempotency_key UNIQUE`) supporting adjustment credits/debits and flagging any payout batch discrepancy $> 100\text{ DZD}$.

---

## Master Engineering Specification (V4)

### 1. Cryptographic Envelope (`AES-256-GCM` + `AAD`)
All credentials in `courier_accounts` (`api_id_encrypted`, `api_token_encrypted`, `webhook_secret_encrypted`) use:
```text
v{key_version}:{iv_24_hex}:{auth_tag_32_hex}:{ciphertext_hex}
```
* **IV:** 12 bytes = 24 hex characters.
* **Auth Tag:** 16 bytes = 32 hex characters.
* **AAD:** `"{tenant_id}:{courier_code}"` bound via `cipher.setAAD()` so ciphertexts cannot be transplanted across tenants.

### 2. Phase-Gated Cyclic State Machine

```text
[ Phase 1: PREPARATION ] (Rank 1)
    Statuses: EN_PREPARATION, NOT_COLLECTED
       │
       ▼
[ Phase 2: IN_TRANSIT ] (Rank 2)
    Statuses: EXPEDIE, EN_HUB, EN_TRANSIT
       │
       ▼
[ Phase 3: DELIVERY_LOOP ] (Rank 3) ◄──┐ (Cyclic: Free transitions within Phase 3)
    Statuses:                          │
      - SORTI_EN_LIVRAISON             │ (Increment attempt_count on each TENTATIVE_ECHOUEE)
      - AU_BUREAU                      │
      - TENTATIVE_ECHOUEE ─────────────┘
      - EN_ATTENTE_DU_CLIENT
       │
       ├────────────────────────────────────────┐
       │                                        ▼
       │                             [ Phase 4B: RETURN_IN_TRANSIT ] (Rank 4)
       │                                 Statuses: RETOUR_EN_COURS, EN_ATTENTE_DE_RETOUR
       │                                 (Can ONLY advance to Phase 4 or Phase 5; cannot regress to 1-3)
       │                                        │
       ▼                                        ▼
[ Phase 4: TERMINAL_DELIVERED ] (Rank 5)  [ Phase 5: TERMINAL_RETURNED ] (Rank 5)
    Status: LIVRE                             Status: RETOURNE_AU_VENDEUR
    (LOCKED: Terminal)                        (LOCKED: Terminal — triggers return penalty & restock)
```

### 3. COD Financial Reconciliation Formula

$$\text{Net Payout} = \sum \text{COD Credits} + \sum \text{Adjustment Credits} - \sum \left( \text{Base Delivery} + \text{Return Penalties} + \text{COD Fees} + \text{Weight Surcharges} + \text{Insurance} + \text{Exchange Fees} + \text{Adjustment Debits} \right)$$

---

## Quickstart & Testing (Postman + Automated Suite)

### 1. Run the Automated Verification Suite
Tests AES-256-GCM envelope encryption + cross-tenant AAD protection, Algerian mobile/VoIP/landline phone normalization, all 4 courier adapters, the Redis quota throttler, the phase-gated state machine, and COD ledger reconciliation:
```bash
npm install
npm test
```

### 2. Test Live in Postman (No Courier Keys Required!)
1. Start the built-in Local Sandbox Server on `http://localhost:4000`:
   ```bash
   npm run start:sandbox
   ```
2. Open **Postman** $\rightarrow$ Click **Import** $\rightarrow$ Select `postman/Algerian_Multi_Courier_Engine.postman_collection.json`.
3. Open **Folder 1 (`1. Local Engine Sandbox`)** in Postman to test:
   * `POST /api/sandbox/dispatch` — Test translating an order into Yalidine, ZR Express, Ecotrack (2-Step), or Maystro payloads.
   * `POST /api/sandbox/webhook` — Test Phase-Gate state transitions (`Phase 1 -> Phase 3 -> Phase 4B -> Phase 4/5`) and Redis dedup keys.
   * `POST /api/sandbox/reconcile` — Test COD financial payout auditing and $>100\text{ DZD}$ discrepancy detection.
   * `POST /api/sandbox/encrypt` — Test `AES-256-GCM` `24-hex IV` + `32-hex Tag` + `AAD` encryption.
4. Open **Folder 2 (`2. Live Courier APIs`)** when you have real API keys: paste your credentials into the Collection Variables (`YALIDINE_API_ID`, `YALIDINE_API_TOKEN`, `ECOTRACK_API_TOKEN`, etc.) to test live courier endpoints directly from Postman.

### 3. Initialize PostgreSQL Schema
```bash
psql "$DATABASE_URL" -f sql/001_schema_v4.sql
```

