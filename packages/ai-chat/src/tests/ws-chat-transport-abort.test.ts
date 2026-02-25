import { describe, it, expect } from "vitest";
import type { UIMessage as ChatMessage } from "ai";
import { connectChatWS } from "./test-utils";
import { WebSocketChatTransport } from "../ws-chat-transport";

function connectSlowStream(room: string) {
  return connectChatWS(`/agents/slow-stream-agent/${room}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Timed out")), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  }) as Promise<T>;
}

async function readUntilDoneOrAbort(
  reader: ReadableStreamDefaultReader<unknown>,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for stream to end");

    try {
      const result = await withTimeout(reader.read(), remaining);
      if (result.done) return;
    } catch (err) {
      if (err && typeof err === "object" && "name" in err) {
        if ((err as { name: unknown }).name === "AbortError") return;
      }
      throw err;
    }
  }
}

const userMessage: ChatMessage = {
  id: "msg1",
  role: "user",
  parts: [{ type: "text", text: "Hello" }]
};

describe("WebSocketChatTransport", () => {
  it("terminates the stream when abortSignal fires", async () => {
    const room = crypto.randomUUID();
    const { ws } = await connectSlowStream(room);
    await new Promise((r) => setTimeout(r, 50));

    try {
      const transport = new WebSocketChatTransport<ChatMessage>({ agent: ws });
      const abortController = new AbortController();

      const stream = await transport.sendMessages({
        chatId: "chat",
        messages: [userMessage],
        abortSignal: abortController.signal,
        trigger: "submit-message",
        body: {
          format: "plaintext",
          chunkCount: 20,
          chunkDelayMs: 50
        }
      });

      const reader = stream.getReader();

      // Abort mid-stream. Without proper stream termination, this would hang.
      setTimeout(() => abortController.abort(), 200);

      await expect(readUntilDoneOrAbort(reader, 5000)).resolves.toBeUndefined();
    } finally {
      ws.close(1000);
    }
  });
});
