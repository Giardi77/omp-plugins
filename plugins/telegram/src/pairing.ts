import type { TelegramUpdate } from "./bot-api.ts";

/**
 * Pairing handshake: the plugin shows a one-time code in the TUI, the user sends it to the
 * bot, and the chat it arrives in becomes the paired home chat. No manual chat-ID hunting.
 * Bot usernames are public, so until pairing completes the bridge ignores every chat.
 */

/** Unambiguous 32-symbol alphabet (no 0/O, 1/I/L); 256 % 32 === 0 keeps byte→symbol uniform. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 6;

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function generatePairingCode(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export interface PairingResult {
  chatId: number;
  userId: number;
  username?: string;
}

export class PairingTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Pairing timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "PairingTimeoutError";
  }
}

export type UpdateSubscriber = (listener: (update: TelegramUpdate) => void) => () => void;

/** Wait for the pairing code as a plain message or `/start <code>`; resolves with its chat. */
export function waitForPairing(
  subscribe: UpdateSubscriber,
  code: string,
  options: { timeoutMs: number },
): Promise<PairingResult> {
  const { promise, resolve, reject } = Promise.withResolvers<PairingResult>();
  const timer = setTimeout(() => {
    unsubscribe();
    reject(new PairingTimeoutError(options.timeoutMs));
  }, options.timeoutMs);

  const unsubscribe = subscribe(update => {
    const message = update.message;
    if (!message?.text || message.from?.is_bot) return;
    const text = message.text.trim();
    if (text !== code && text !== `/start ${code}`) return;
    clearTimeout(timer);
    unsubscribe();
    resolve({
      chatId: message.chat.id,
      userId: message.from?.id ?? 0,
      ...(message.from?.username ? { username: message.from.username } : {}),
    });
  });

  return promise;
}
