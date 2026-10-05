export class RequestBodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Enforce the actual streamed size; Content-Length alone is not a boundary. */
export async function readJsonObject(req: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyError('Request body too large', 413);
  }
  if (!req.body) throw new RequestBodyError('JSON object required', 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestBodyError('Request body timed out', 408));
      void reader.cancel().catch(() => {});
    }, 5_000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new RequestBodyError('Request body too large', 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new RequestBodyError('Invalid JSON body', 400);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new RequestBodyError('JSON object required', 400);
    }
    return result as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
