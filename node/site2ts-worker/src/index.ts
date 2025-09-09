import readline from 'node:readline';
import { ulid } from 'ulid';

type Json = any;

type RpcRequest = {
  jsonrpc?: string;
  method: string;
  params?: Json;
  id?: string | number | null;
};

type RpcResponse = {
  jsonrpc: '2.0';
  result?: Json;
  error?: { code: number; message: string; data?: Json };
  id?: string | number | null;
};

function respond(ok: boolean, payload: Json, id?: RpcRequest['id']) {
  const resp: RpcResponse = {
    jsonrpc: '2.0',
    ...(ok ? { result: payload } : { error: payload }),
    id,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(resp));
}

function handle(method: string, params: Json): Json {
  switch (method) {
    case 'ping':
      return { ok: true, msg: 'site2ts-worker ready' };
    case 'crawl': {
      // Stub: mirror server contract shape minimally
      const jobId = ulid();
      const siteMapId = ulid();
      return { jobId, siteMapId, pages: [] };
    }
    default:
      throw Object.assign(new Error('method not found'), { code: -32601 });
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch (e: any) {
      respond(false, { code: -32700, message: `parse error: ${e?.message || e}` });
      return;
    }
    try {
      const res = handle(req.method, req.params || {});
      respond(true, res, req.id);
    } catch (e: any) {
      respond(false, { code: e?.code ?? -32603, message: e?.message ?? 'internal error' }, req.id);
    }
  });
}

main();
