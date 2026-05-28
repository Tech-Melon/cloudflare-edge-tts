import { createAudioStream } from "../lib/tts";
import { CORS_HEADERS, errorResponse } from "../lib/http";

type TtsBody = {
  text?: unknown;
  voice?: unknown;
  rate?: unknown;
  pitch?: unknown;
};

function isJsonContentType(value: string) {
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function parseBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }

  const { text, voice, rate, pitch } = body as TtsBody;

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("text is required");
  }

  if (voice !== undefined) {
    if (typeof voice !== "string") {
      throw new Error("voice must be a string");
    }

    if (voice.trim().length === 0) {
      throw new Error("voice must be a non-empty string");
    }
  }

  if (rate !== undefined && typeof rate !== "string") {
    throw new Error("rate must be a string");
  }

  if (pitch !== undefined && typeof pitch !== "string") {
    throw new Error("pitch must be a string");
  }

  return {
    text: text.trim(),
    voice: typeof voice === "string" ? voice.trim() : voice,
    rate: typeof rate === "string" ? rate.trim() : rate,
    pitch: typeof pitch === "string" ? pitch.trim() : pitch,
  };
}

async function primeAudioStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const firstChunk = await reader.read();
  let firstChunkConsumed = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!firstChunkConsumed) {
          firstChunkConsumed = true;

          if (firstChunk.done) {
            controller.close();
            return;
          }

          controller.enqueue(firstChunk.value);
          return;
        }

        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }

        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export async function handleTts(request: Request, ctx: ExecutionContext) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!isJsonContentType(contentType)) {
    return errorResponse(
      400,
      "INVALID_CONTENT_TYPE",
      "content-type must be application/json"
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "request body must be valid json"
    );
  }

  let parsed: ReturnType<typeof parseBody>;

  try {
    parsed = parseBody(body);
  } catch (error) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      error instanceof Error ? error.message : "request body must be valid json"
    );
  }

  // 构建 Cache Key: 使用 GET 方法的 URL 加上 text, voice, rate, pitch 参数
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set("text", parsed.text);
  cacheUrl.searchParams.set("voice", parsed.voice || "default");
  cacheUrl.searchParams.set("rate", parsed.rate || "default");
  cacheUrl.searchParams.set("pitch", parsed.pitch || "default");
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = (caches as any).default;

  try {
    // 首先检查边缘节点是否存在缓存
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      // 命中边缘缓存，直接返回 (0 延迟)
      return cachedResponse;
    }
  } catch (e) {
    // 忽略缓存读取错误
  }

  try {
    const stream = await createAudioStream(parsed);
    const primedStream = await primeAudioStream(stream);

    const response = new Response(primedStream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=31536000", // 强制 CDN 缓存 1 年
      },
    });

    // 将原始流克隆一份并放入 Edge Cache 中，这样才不会消耗原始 Response 的 body
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch {
    return errorResponse(502, "TTS_UPSTREAM_ERROR", "failed to synthesize audio");
  }
}
