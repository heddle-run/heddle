import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors.js';

/** Read a JSON request body, enforcing a hard size ceiling. */
export function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): HttpError =>
      new HttpError(413, `request body exceeds ${maxBytes} bytes`, 'PayloadTooLarge');

    // Reject on the declared length before reading anything, when it is given.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(tooLarge());
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        // Stop consuming, but do not destroy the socket: the response still
        // has to travel back over it, or the client sees a connection reset
        // instead of a 413.
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);

    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new HttpError(400, 'request body is not valid JSON'));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new HttpError(400, 'request body must be a JSON object'));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
