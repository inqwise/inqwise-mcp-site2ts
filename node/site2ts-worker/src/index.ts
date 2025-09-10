import readline from 'node:readline';
import { crawl, CrawlParams } from './crawl';
import { analyze } from './analyze';
import { scaffold } from './scaffold';
import { generate } from './generate';

type Json = unknown;

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

async function handleAsync(method: string, params: Json): Promise<Json> {
  switch (method) {
    case 'ping':
      return { ok: true, msg: 'site2ts-worker ready' };
    case 'crawl': {
      const p = params as CrawlParams;
      if (!p?.startUrl) throw Object.assign(new Error('startUrl required'), { code: -32602 });
      return await crawl(p);
    }
    case 'analyze': {
      const siteMapId = (params?.siteMapId as string) || '';
      if (!siteMapId) throw Object.assign(new Error('siteMapId required'), { code: -32602 });
      return await analyze(siteMapId);
    }
    case 'scaffold': {
      const analysisId = (params?.analysisId as string) || '';
      if (!analysisId) throw Object.assign(new Error('analysisId required'), { code: -32602 });
      const appRouter = Boolean(params?.appRouter ?? true);
      return await scaffold({ analysisId, appRouter });
    }
    case 'generate': {
      const analysisId = (params?.analysisId as string) || '';
      const scaffoldId = (params?.scaffoldId as string) || '';
      const tailwindMode = (params?.tailwindMode as string) || 'full';
      if (!analysisId) throw Object.assign(new Error('analysisId required'), { code: -32602 });
      if (!scaffoldId) throw Object.assign(new Error('scaffoldId required'), { code: -32602 });
      return await generate(analysisId, scaffoldId, tailwindMode);
    }
    default:
      throw Object.assign(new Error('method not found'), { code: -32601 });
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      respond(false, { code: -32700, message: `parse error: ${msg}` });
      return;
    }
    try {
      const res = await handleAsync(req.method, req.params || {});
      respond(true, res, req.id);
    } catch (e: unknown) {
      const code = typeof (e as any)?.code === 'number' ? (e as any).code : -32603;
      const message = (e as any)?.message ?? 'internal error';
      respond(false, { code, message }, req.id);
    }
  });
}

main();
