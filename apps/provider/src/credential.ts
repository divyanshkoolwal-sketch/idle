import { convertHexToString } from 'xrpl';

/** The exchange may send the credential type as plain text ("IDLE_DC_TIER_A") or hex; normalise to plain text. */
export function decodeCredentialType(value: string): string {
  if (/^[0-9A-Fa-f]+$/.test(value) && value.length % 2 === 0) {
    try {
      const decoded = convertHexToString(value);
      if (/^[\x20-\x7e]+$/.test(decoded)) return decoded;
    } catch {
      /* fall through */
    }
  }
  return value;
}
