import { NormalizedOrderInput, NormalizedDispatchResult } from './types';
import {
  normalizePrimaryMobile,
  normalizeSecondaryPhone,
  formatYalidineAddressWithSecondaryPhone,
} from '../normalizers/phone';

export interface YalidineParcelPayload {
  order_id: string;
  from_wilaya_name: string;
  firstname: string;
  familyname: string;
  contact_phone: string;
  address: string;
  to_wilaya_name: string;
  to_commune_name: string;
  is_stopdesk: boolean;
  stopdesk_id: number | null;
  price: number;
  freeshipping: boolean;
  product_list: string;
  has_exchange: boolean;
  product_to_collect: string | null;
  do_insurance: boolean;
  declared_value: number;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number;
}

export function buildYalidinePayload(order: NormalizedOrderInput): YalidineParcelPayload {
  const parts = order.customerName.trim().split(/\s+/);
  const firstname = parts[0] || 'Client';
  const familyname = parts.slice(1).join(' ') || '.';

  const primary = normalizePrimaryMobile(order.phonePrimary);
  const secondary = normalizeSecondaryPhone(order.phoneSecondary);

  return {
    order_id: order.reference,
    from_wilaya_name: order.originWilayaName,
    firstname,
    familyname,
    contact_phone: primary,
    address: formatYalidineAddressWithSecondaryPhone(order.deliveryAddress, secondary),
    to_wilaya_name: order.destinationWilayaName,
    to_commune_name: order.destinationCommuneName,
    is_stopdesk: order.isStopdesk,
    stopdesk_id: order.isStopdesk && order.stopdeskId ? Number(order.stopdeskId) : null,
    price: Math.round(order.totalCodAmount),
    freeshipping: order.isFreeShipping,
    product_list: order.productDescription,
    has_exchange: order.hasExchange,
    product_to_collect: order.hasExchange ? order.productToCollect || 'Echange' : null,
    do_insurance: order.doInsurance,
    declared_value: order.doInsurance ? Math.round(order.declaredValue) : 0,
    length: null,
    width: null,
    height: null,
    weight: order.estimatedWeight,
  };
}

/**
 * Normalizes Yalidine's keyed-object batch response:
 * { "ORD-12345": { "success": true, "tracking": "yal-123", "label": "https://...", "message": "" } }
 */
export function parseYalidineBatchResponse(
  rawResponse: Record<string, any>
): NormalizedDispatchResult[] {
  return Object.entries(rawResponse).map(([reference, item]) => ({
    reference,
    success: Boolean(item?.success),
    tracking: item?.tracking || undefined,
    isValidatedByCourier: true,
    labelUrl: item?.label || item?.labels || undefined,
    errorMessage: item?.success ? undefined : item?.message || 'Yalidine dispatch error',
    rawResponse: item,
  }));
}
