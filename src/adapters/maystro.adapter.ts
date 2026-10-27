import { NormalizedOrderInput } from './types';
import { normalizePrimaryMobile, normalizeSecondaryPhone } from '../normalizers/phone';

/**
 * Builds Maystro Delivery payload (POST https://backend.maystro-delivery.com/api/stores/orders/).
 * - Requires Maystro's integer commune ID (destinationCommuneId).
 * - When isStopdesk = true (delivery_type = 2), destinationCommuneId must be the Stop-Desk's host commune ID.
 * - Uses defaultProductUuid provisioned during Maystro account onboarding.
 */
export function buildMaystroPayload(
  order: NormalizedOrderInput,
  defaultProductUuid: string
) {
  if (!order.destinationCommuneId) {
    throw new Error('Maystro requires an integer courier_commune_id');
  }

  const primary = normalizePrimaryMobile(order.phonePrimary);
  const secondary = normalizeSecondaryPhone(order.phoneSecondary);
  const isSecondaryMobile = secondary?.type === 'MOBILE';

  return {
    external_id: order.reference,
    customer_name: order.customerName,
    customer_phone: primary,
    customer_phone2: isSecondaryMobile ? secondary.canonical : '',
    destination_text: order.deliveryAddress,
    wilaya: order.destinationWilayaId,
    commune: Number(order.destinationCommuneId),
    delivery_type: order.isStopdesk ? 2 : 1,
    product_price: Math.round(order.totalCodAmount),
    express: false,
    note_to_driver:
      secondary && !isSecondaryMobile ? `Tel Fixe: ${secondary.canonical}` : '',
    details: [
      {
        product: defaultProductUuid,
        description: order.productDescription,
        quantity: 1,
      },
    ],
  };
}
