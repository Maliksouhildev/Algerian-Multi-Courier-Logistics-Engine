import { NormalizedOrderInput } from './types';
import { normalizePrimaryMobile, normalizeSecondaryPhone } from '../normalizers/phone';

export function buildZrExpressPayload(order: NormalizedOrderInput) {
  const primary = normalizePrimaryMobile(order.phonePrimary);
  const secondary = normalizeSecondaryPhone(order.phoneSecondary);

  return {
    Colis: [
      {
        ID_Externe: order.reference,
        Tracking: '',
        TypeLivraison: order.isStopdesk ? 1 : 0,
        TStopDesk: order.isStopdesk && order.stopdeskId ? Number(order.stopdeskId) : 0,
        TypeColis: order.hasExchange ? 1 : 0,
        Confrim: 1,
        Client: order.customerName,
        MobileA: primary,
        MobileB: secondary ? secondary.canonical : '',
        Adresse: order.deliveryAddress,
        IDWilaya: order.destinationWilayaId,
        Commune: order.destinationCommuneName,
        Total: Math.round(order.totalCodAmount),
        Produit: order.productDescription,
        Note: order.hasExchange && order.productToCollect
          ? `Echange: ${order.productToCollect}`
          : '',
        Poids: order.estimatedWeight,
      },
    ],
  };
}
