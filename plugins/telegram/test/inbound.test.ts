import { describe, expect, test } from "bun:test";
import { TelegramBotApi } from "../src/bot-api.ts";
import { messageToPrompt } from "../src/inbound.ts";

function fakeTelegram(photoBytes?: Uint8Array<ArrayBuffer>) {
  const fetchImpl = async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.includes("/file/bot")) {
      return new Response(new Blob([photoBytes ?? new Uint8Array(0)]), { status: 200 });
    }
    if (url.endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_id: "p1", file_path: "photos/file_1.jpg" } }), {
        status: 200,
      });
    }
    throw new Error(`unexpected call: ${url}`);
  };
  return new TelegramBotApi("t", fetchImpl);
}

const baseMessage = { message_id: 1, chat: { id: 42, type: "private" }, date: 0 };

describe("messageToPrompt", () => {
  test("text passes through", async () => {
    const prompt = await messageToPrompt(fakeTelegram(), { ...baseMessage, text: "fix the leak" });
    expect(prompt).toBe("fix the leak");
  });

  test("photo becomes a base64 jpeg image, caption becomes text", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
    const prompt = await messageToPrompt(fakeTelegram(bytes), {
      ...baseMessage,
      photo: [
        { file_id: "small", width: 90, height: 90 },
        { file_id: "large", width: 800, height: 800 },
      ],
      caption: "this screen leaks sessions",
    });
    expect(Array.isArray(prompt)).toBe(true);
    if (!Array.isArray(prompt)) return;
    expect(prompt).toHaveLength(2);
    expect(prompt[0]).toEqual({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" });
    expect(prompt[1]).toEqual({ type: "text", text: "this screen leaks sessions" });
  });

  test("photo without caption is image-only", async () => {
    const prompt = await messageToPrompt(fakeTelegram(new Uint8Array([1])), {
      ...baseMessage,
      photo: [{ file_id: "p", width: 1, height: 1 }],
    });
    expect(Array.isArray(prompt) && prompt).toHaveLength(1);
  });

  test("unsupported messages are ignored", async () => {
    expect(await messageToPrompt(fakeTelegram(), { ...baseMessage })).toBeUndefined();
  });
});
