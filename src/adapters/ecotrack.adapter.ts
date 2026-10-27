import { NormalizedOrderInput } from './types';
import { normalizePrimaryMobile, normalizeSecondaryPhone } from '../normalizers/phone';

/**
 * Step A Payload: POST {base_url}/api/v1/create/order
 * Note: Parcel remains in draft (is_validated_by_courier = FALSE) until Step B
 * (POST {base_url}/api/v1/valid/order) succeeds.
 */
export function buildEcotrackCreatePayload(order: NormalizedOrderInput) {
  const primary = normalizePrimaryMobile(order.phonePrimary);
  const secondary = normalizeSecondaryPhone(order.phoneSecondary);

  const isSecondaryMobile = secondary?.type === 'MOBILE';
  const notes: string[] = [];
  if (secondary && !isSecondaryMobile) {
    notes.push(`Tel 2: ${secondary.canonical}`);
  }
  if (order.hasExchange && order.productToCollect) {
    notes.push(`Echange: ${order.productToCollect}`);
  }

  return {
    reference: order.reference,
    nom_client: order.customerName,
    telephone: primary,
    telephone_2: isSecondaryMobile ? secondary.canonical : '',
    adresse: order.deliveryAddress,
    code_wilaya: order.destinationWilayaId,
    commune: order.destinationCommuneName,
    montant: Math.round(order.totalCodAmount),
    type: order.hasExchange ? 2 : 1, // 1 = Livraison, 2 = Echange
    stop_desk: order.isStopdesk ? 1 : 0,
    Id_stopdesk: order.isStopdesk && order.stopdeskId ? order.stopdeskId : null,
    produit: order.productDescription,
    quantite: 1,
    poids: order.estimatedWeight,
    remarque: notes.join(' | '),
  };
}

/**
 * Step B Payload: POST {base_url}/api/v1/valid/order
 */
export function buildEcotrackValidationPayload(tracking: string, askCollection = 1) {
  return {
    tracking,
    ask_collection: askCollection,
  };
}
