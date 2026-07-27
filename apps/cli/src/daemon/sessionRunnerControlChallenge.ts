import { randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

const CHALLENGE_PATH = '/session-runner/challenge';
const MAX_CHALLENGE_BODY_BYTES = 4_096;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 750;

type ChallengePayload = Readonly<{
  sessionId: string;
  generationId: string;
  nonce: string;
}>;

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidGenerationId(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,128}$/.test(value);
}

function isValidNonce(value: string): boolean {
  return /^[A-Za-z0-9._-]{8,128}$/.test(value);
}

function parseChallengePayload(raw: string): ChallengePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ChallengePayload>;
    const sessionId = normalizeNonEmptyString(parsed.sessionId);
    const generationId = normalizeNonEmptyString(parsed.generationId);
    const nonce = normalizeNonEmptyString(parsed.nonce);
    if (!sessionId || !isValidGenerationId(generationId) || !isValidNonce(nonce)) return null;
    return { sessionId, generationId, nonce };
  } catch {
    return null;
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_CHALLENGE_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export type SessionRunnerControlChallengeServer = Readonly<{
  port: number;
  close: () => Promise<void>;
}>;

export async function startSessionRunnerControlChallengeServer(params: Readonly<{
  sessionId: string;
  generationId: string;
}>): Promise<SessionRunnerControlChallengeServer> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  const generationId = normalizeNonEmptyString(params.generationId);
  if (!sessionId || !isValidGenerationId(generationId)) {
    throw new Error('Invalid session runner control challenge identity');
  }

  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== CHALLENGE_PATH) {
      writeJson(response, 404, { ok: false });
      return;
    }

    const rawBody = await readBoundedBody(request).catch(() => null);
    const challenge = rawBody === null ? null : parseChallengePayload(rawBody);
    if (
      !challenge
      || challenge.sessionId !== sessionId
      || challenge.generationId !== generationId
    ) {
      writeJson(response, 403, { ok: false });
      return;
    }

    writeJson(response, 200, {
      ok: true,
      sessionId,
      generationId,
      nonce: challenge.nonce,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Session runner control challenge server did not bind a TCP port');
  }

  let closed = false;
  return {
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

export async function challengeSessionRunnerControl(params: Readonly<{
  sessionId: string;
  generationId: string;
  controlPort: number;
  nonce?: string;
  timeoutMs?: number;
}>): Promise<boolean> {
  const sessionId = normalizeNonEmptyString(params.sessionId);
  const generationId = normalizeNonEmptyString(params.generationId);
  const nonce = normalizeNonEmptyString(params.nonce ?? randomUUID());
  const controlPort = Math.floor(params.controlPort);
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs ?? DEFAULT_CHALLENGE_TIMEOUT_MS));
  if (
    !sessionId
    || !isValidGenerationId(generationId)
    || !isValidNonce(nonce)
    || !Number.isInteger(controlPort)
    || controlPort < 1
    || controlPort > 65_535
  ) {
    return false;
  }

  const requestBody = JSON.stringify({ sessionId, generationId, nonce });
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: controlPort,
      path: CHALLENGE_PATH,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > MAX_CHALLENGE_BODY_BYTES) {
          response.destroy();
          finish(false);
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          finish(false);
          return;
        }
        const challenge = parseChallengePayload(Buffer.concat(chunks).toString('utf8'));
        finish(
          challenge?.sessionId === sessionId
          && challenge.generationId === generationId
          && challenge.nonce === nonce,
        );
      });
      response.on('error', () => finish(false));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('challenge_timeout')));
    request.on('error', () => finish(false));
    request.end(requestBody);
  });
}
