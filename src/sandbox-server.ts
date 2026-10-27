import http from 'http';
import crypto from 'crypto';
import { encryptCredential, decryptCredential } from './crypto/envelope';
import { buildYalidinePayload } from './adapters/yalidine.adapter';
import { buildZrExpressPayload } from './adapters/zrexpress.adapter';
import {
  buildEcotrackCreatePayload,
  buildEcotrackValidationPayload,
} from './adapters/ecotrack.adapter';
import { buildMaystroPayload } from './adapters/maystro.adapter';
import { canTransitionPhase, computeWebhookDedupHash } from './state-machine/phase-gate';
import { auditCourierDisbursementBatch } from './ledger/reconciler';

const PORT = Number(process.env.PORT || 4000);
const DEMO_KEY_V1 =
  process.env.ENCRYPTION_KEY_V1 || crypto.randomBytes(32).toString('hex');

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { status: 'ok', version: '4.0.0' });
    }

    if (req.method === 'POST' && req.url === '/api/sandbox/dispatch') {
      const body = await readJsonBody(req);
      const { courierCode, order } = body;

      if (courierCode === 'yalidine') {
        const payload = buildYalidinePayload(order);
        return sendJson(res, 200, {
          courierCode,
          endpoint: 'POST https://api.yalidine.app/v1/parcels',
          translatedPayload: [payload],
          simulatedResult: {
            reference: order.reference,
            success: true,
            tracking: `yal-${Math.floor(100000 + Math.random() * 900000)}`,
            isValidatedByCourier: true,
            labelStrategy: 'DELAYED_4S_OFFICIAL_DATAMATRIX_PDF',
          },
        });
      }

      if (courierCode === 'zrexpress') {
        const payload = buildZrExpressPayload(order);
        return sendJson(res, 200, {
          courierCode,
          endpoint: 'POST https://procolis.com/api_v1/add_colis',
          translatedPayload: payload,
          simulatedResult: {
            reference: order.reference,
            success: true,
            tracking: `ZR-${Math.floor(100000 + Math.random() * 900000)}`,
            isValidatedByCourier: true,
            labelStrategy: 'LOCAL_PDFKIT_100X100_CODE128',
          },
        });
      }

      if (courierCode?.startsWith('ecotrack')) {
        const tracking = `EC${Math.floor(10000000 + Math.random() * 90000000)}`;
        const stepAPayload = buildEcotrackCreatePayload(order);
        const stepBPayload = buildEcotrackValidationPayload(tracking, 1);
        return sendJson(res, 200, {
          courierCode,
          stepA_CreateDraft: {
            endpoint: 'POST {base_url}/api/v1/create/order',
            payload: stepAPayload,
          },
          stepB_ValidateOrder: {
            endpoint: 'POST {base_url}/api/v1/valid/order',
            payload: stepBPayload,
          },
          simulatedResult: {
            reference: order.reference,
            success: true,
            tracking,
            isValidatedByCourier: true,
            labelStrategy: 'GATED_LOCAL_PDFKIT_AFTER_STEP_B',
          },
        });
      }

      if (courierCode === 'maystro') {
        const payload = buildMaystroPayload(
          order,
          body.defaultProductUuid || 'd3b07384-d113-4e6e-8c9c-123456789abc'
        );
        return sendJson(res, 200, {
          courierCode,
          endpoint: 'POST https://backend.maystro-delivery.com/api/stores/orders/',
          translatedPayload: payload,
          simulatedResult: {
            reference: order.reference,
            success: true,
            tracking: `MYS-${Math.floor(100000 + Math.random() * 900000)}`,
            isValidatedByCourier: true,
            labelStrategy: 'DELAYED_4S_OFFICIAL_DATAMATRIX_PDF',
          },
        });
      }

      return sendJson(res, 400, {
        error: 'Unsupported courierCode. Use yalidine, zrexpress, ecotrack_*, or maystro.',
      });
    }

    if (req.method === 'POST' && req.url === '/api/sandbox/webhook') {
      const body = await readJsonBody(req);
      const {
        courierCode,
        trackingNumber,
        currentPhase,
        targetPhase,
        rawStatus,
        eventTimestamp,
      } = body;

      const allowed = canTransitionPhase(currentPhase, targetPhase);
      const dedupHash = computeWebhookDedupHash(
        courierCode,
        trackingNumber,
        rawStatus,
        eventTimestamp
      );

      return sendJson(res, 200, {
        trackingNumber,
        currentPhase,
        targetPhase,
        transitionAllowed: allowed,
        newPhase: allowed ? targetPhase : currentPhase,
        returnPenaltyTriggered: allowed && targetPhase === 'TERMINAL_RETURNED',
        redisPostCommitDedupKey: `webhook:dedup:${dedupHash}`,
      });
    }

    if (req.method === 'POST' && req.url === '/api/sandbox/reconcile') {
      const body = await readJsonBody(req);
      const audit = auditCourierDisbursementBatch(
        body.batchReference,
        body.entries,
        body.reportedCourierPayoutDzd
      );
      return sendJson(res, 200, audit);
    }

    if (req.method === 'POST' && req.url === '/api/sandbox/encrypt') {
      const body = await readJsonBody(req);
      const ctx = {
        tenantId: Number(body.tenantId || 1),
        courierCode: String(body.courierCode || 'yalidine'),
      };
      const envelope = encryptCredential(
        String(body.secretPlaintext),
        DEMO_KEY_V1,
        1,
        ctx
      );
      const decryptedVerify = decryptCredential(envelope, () => DEMO_KEY_V1, ctx);

      return sendJson(res, 200, {
        envelope,
        postgresCheckRegexValid:
          /^v[0-9]+:[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(envelope),
        aadBoundTo: `${ctx.tenantId}:${ctx.courierCode}`,
        decryptedMatchesOriginal: decryptedVerify === body.secretPlaintext,
      });
    }

    return sendJson(res, 404, { error: 'Route not found' });
  } catch (err: any) {
    return sendJson(res, 400, { error: err?.message || 'Bad Request' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(
      `[Algerian Multi-Courier Sandbox Server] Listening on http://localhost:${PORT}`
    );
  });
}
