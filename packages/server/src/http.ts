import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors.js';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): HttpError =>
      new HttpError(
        413,
        `request body exceeds ${maxBytes} bytes`,
        'PayloadTooLarge',
      );

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
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);

    req.on('end', () => {
      if (settled) return;

      try {
        resolve(parseJsonObject(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
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
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...headers,
    'content-type': PROMETHEUS_CONTENT_TYPE,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
