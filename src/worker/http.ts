const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export const defaultJsonBodyMaxBytes = 256 * 1024;
export const largeImportJsonBodyMaxBytes = 5 * 1024 * 1024;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function readJson<T>(request: Request, maxBytes = defaultJsonBodyMaxBytes): Promise<T> {
  const text = await readLimitedRequestText(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "Malformed JSON");
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...jsonHeaders, ...headers } });
}

async function readLimitedRequestText(request: Request, maxBytes: number): Promise<string> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413, "Request body too large");
  if (!request.body) return request.text();

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}
