import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/** Parses user input and returns it in E.164 form, or null if it is not a valid number. */
export function toE164(input: string, defaultRegion: string = 'US'): string | null {
  if (!input) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), defaultRegion as CountryCode);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatNational() : e164;
}
