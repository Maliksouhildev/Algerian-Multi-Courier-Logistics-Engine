export interface NormalizedOrderInput {
  reference: string;
  customerName: string;
  phonePrimary: string;
  phoneSecondary?: string | null;
  deliveryAddress: string;
  originWilayaName: string;
  destinationWilayaId: number;
  destinationWilayaName: string;
  destinationCommuneId?: string | number | null;
  destinationCommuneName: string;
  isStopdesk: boolean;
  stopdeskId?: string | null;
  productDescription: string;
  totalCodAmount: number;
  isFreeShipping: boolean;
  declaredValue: number;
  doInsurance: boolean;
  hasExchange: boolean;
  productToCollect?: string | null;
  estimatedWeight: number;
}

export interface NormalizedDispatchResult {
  reference: string;
  success: boolean;
  tracking?: string;
  isValidatedByCourier: boolean;
  labelUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  rawResponse?: unknown;
}
