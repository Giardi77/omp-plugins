import type { TelegramBotApi, TelegramMessage } from "./bot-api.ts";

/**
 * Inbound conversion: a Telegram message in the paired chat → a prompt for the session.
 * Text passes through; photos download as base64 images (Telegram photos are always jpeg),
 * with the caption as accompanying text. Everything else (stickers, voice, …) is ignored —
 * voice notes land when an STT path exists.
 */

export type InboundPrompt =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export async function messageToPrompt(api: TelegramBotApi, message: TelegramMessage): Promise<InboundPrompt | undefined> {
  if (typeof message.text === "string" && message.text.length > 0) return message.text;

  const photos = message.photo;
  if (!photos || photos.length === 0) return undefined;

  const largest = photos[photos.length - 1];
  const file = await api.getFile(largest.file_id);
  if (!file.file_path) return undefined;

  const buffer = await api.downloadFile(file.file_path);
  const image = {
    type: "image" as const,
    data: Buffer.from(buffer).toString("base64"),
    mimeType: "image/jpeg",
  };
  const caption = message.caption?.trim();
  return caption ? [image, { type: "text" as const, text: caption }] : [image];
}
