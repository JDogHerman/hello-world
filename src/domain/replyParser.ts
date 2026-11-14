/**
 * Interprets an inbound SMS body. Pure: no knowledge of which offers exist.
 *
 * Carrier/CTIA keywords are matched on the whole (trimmed) message, as carriers do.
 * Note: Twilio also treats a bare "YES" from an opted-out number as opt-in; we only
 * treat YES as opt-in when the worker is currently opted out (handled by the caller).
 */
export type ParsedReply =
  | { kind: 'accept'; code: string | null }
  | { kind: 'decline'; code: string | null }
  | { kind: 'opt_out' }
  | { kind: 'opt_in' }
  | { kind: 'help' }
  | { kind: 'unknown' };

export const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'];
export const OPT_IN_KEYWORDS = ['START', 'UNSTOP', 'OPTIN'];
export const HELP_KEYWORDS = ['HELP', 'INFO'];

const ACCEPT_WORDS = ['YES', 'Y', 'YEA', 'YEAH', 'YEP', 'ACCEPT', 'OK', 'OKAY'];
const DECLINE_WORDS = ['NO', 'N', 'NOPE', 'DECLINE', 'PASS'];

export function parseReply(body: string): ParsedReply {
  const text = body
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { kind: 'unknown' };

  if (OPT_OUT_KEYWORDS.includes(text)) return { kind: 'opt_out' };
  if (OPT_IN_KEYWORDS.includes(text)) return { kind: 'opt_in' };
  if (HELP_KEYWORDS.includes(text)) return { kind: 'help' };

  const tokens = text.split(' ');
  const codes = tokens.filter((t) => /^\d{4}$/.test(t));
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  // Accept "YES 4821", "4821 YES", "yes, 4821!" — but exactly one verb and at most one code.
  if (codes.length > 1 || words.length !== 1) return { kind: 'unknown' };
  if (tokens.some((t) => /^\d+$/.test(t) && !/^\d{4}$/.test(t))) return { kind: 'unknown' };

  const code = codes[0] ?? null;
  if (ACCEPT_WORDS.includes(words[0])) return { kind: 'accept', code };
  if (DECLINE_WORDS.includes(words[0])) return { kind: 'decline', code };
  return { kind: 'unknown' };
}

/** Random 4-digit code (1000–9999) not in `taken`. */
export function generateOfferCode(taken: ReadonlySet<string>, rand: () => number = Math.random): string {
  for (let i = 0; i < 1000; i++) {
    const code = String(1000 + Math.floor(rand() * 9000));
    if (!taken.has(code)) return code;
  }
  throw new Error('Could not allocate a unique offer code');
}
