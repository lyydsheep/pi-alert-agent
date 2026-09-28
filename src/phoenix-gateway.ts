import type { RequestListener } from 'node:http';
import { Kind, parse } from 'graphql';

export interface PhoenixGatewayOptions {
  upstream: string;
  viewerKey: string;
}

const UI_PREFIXES = ['/projects', '/datasets', '/experiments', '/prompts', '/evaluators', '/traces', '/sessions'];
const STATIC_PREFIXES = ['/assets/', '/static/', '/_next/'];
const API_PREFIXES = ['/v1/projects', '/v1/datasets', '/v1/experiments', '/v1/prompts', '/v1/spans', '/v1/traces', '/v1/evaluations', '/v1/annotations', '/v1/annotation_configs'];

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function allowedGet(path: string): boolean {
  return path === '/' || path === '/healthz' || path === '/arize-phoenix-version'
    || UI_PREFIXES.some((prefix) => within(path, prefix))
    || STATIC_PREFIXES.some((prefix) => path.startsWith(prefix))
    || API_PREFIXES.some((prefix) => within(path, prefix))
    || /^\/(?:favicon\.ico|manifest\.json|robots\.txt)$/.test(path);
}

async function body(request: Parameters<RequestListener>[0]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new Error('request too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function queryOnly(bytes: Buffer): boolean {
  try {
    const payload = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { query?: unknown }).query !== 'string') return false;
    const document = parse((payload as { query: string }).query);
    const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
    return operations.length > 0 && operations.every((operation) => operation.operation === 'query');
  } catch {
    return false;
  }
}

function deny(response: Parameters<RequestListener>[1], status = 403): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(status === 413 ? 'Request too large' : 'Forbidden');
}

export function createPhoenixGateway(options: PhoenixGatewayOptions): RequestListener {
  if (!options.viewerKey) throw new Error('Phoenix Viewer API key is required');
  const upstream = new URL(options.upstream);

  return async (request, response) => {
    try {
      const incoming = new URL(request.url ?? '/', 'http://gateway.invalid');
      const method = request.method ?? 'GET';
      let requestBody: Buffer | undefined;
      if (incoming.pathname === '/graphql' && method === 'POST') {
        requestBody = await body(request);
        if (!queryOnly(requestBody)) return deny(response);
      } else if (!((method === 'GET' || method === 'HEAD') && allowedGet(incoming.pathname))) {
        return deny(response);
      }

      const target = new URL(`${incoming.pathname}${incoming.search}`, upstream);
      const result = await fetch(target, {
        method,
        headers: {
          authorization: `Bearer ${options.viewerKey}`,
          ...(request.headers.accept ? { accept: request.headers.accept } : {}),
          ...(requestBody ? { 'content-type': 'application/json' } : {}),
        },
        body: requestBody?.toString('utf8'),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if (result.status >= 300 && result.status < 400) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return response.end('Phoenix Viewer authentication did not produce a direct response');
      }

      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'content-language']) {
        const value = result.headers.get(name);
        if (value) headers[name] = value;
      }
      response.writeHead(result.status, headers);
      if (method === 'HEAD' || !result.body) return response.end();
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof Error && error.message === 'request too large' ? 413 : 502;
        return deny(response, status);
      }
      response.destroy(error as Error);
    }
  };
}
