export type AlgerianPhoneType = 'MOBILE' | 'VOIP_FIXED' | 'LANDLINE';

export interface NormalizedPhone {
  canonical: string;
  type: AlgerianPhoneType;
}

function stripAlgerianPrefix(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00213')) {
    digits = digits.slice(5);
  } else if (digits.startsWith('213') && digits.length >= 11) {
    digits = digits.slice(3);
  }
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return digits;
}

/**
 * Normalizes primary phone: strictly mandatory 10-digit Algerian mobile (05, 06, 07).
 */
export function normalizePrimaryMobile(raw: string): string {
  const core = stripAlgerianPrefix(raw);
  if (!/^[567]\d{8}$/.test(core)) {
    throw new Error(`Invalid Algerian mobile number: ${raw}`);
  }
  return `0${core}`;
}

/**
 * Normalizes secondary phone: supports 10-digit mobile (05/06/07),
 * 10-digit Algérie Télécom VoIP/FTTH/4G fixed line (09),
 * or 9-digit geographic PSTN landline (01-04).
 */
export function normalizeSecondaryPhone(raw?: string | null): NormalizedPhone | null {
  if (!raw || !raw.trim()) return null;
  const core = stripAlgerianPrefix(raw);

  if (/^[567]\d{8}$/.test(core)) {
    return { canonical: `0${core}`, type: 'MOBILE' };
  }
  if (/^9\d{8}$/.test(core)) {
    return { canonical: `0${core}`, type: 'VOIP_FIXED' };
  }
  if (/^[1-4]\d{7}$/.test(core)) {
    return { canonical: `0${core}`, type: 'LANDLINE' };
  }

  throw new Error(`Invalid Algerian secondary phone or landline: ${raw}`);
}

/**
 * Prepends secondary phone to Yalidine address so 10x10cm thermal label truncation
 * never cuts off the backup phone number.
 */
export function formatYalidineAddressWithSecondaryPhone(
  address: string,
  secondaryPhone?: NormalizedPhone | null
): string {
  if (!secondaryPhone) return address;
  return `[Tel 2: ${secondaryPhone.canonical}] - ${address}`;
}
