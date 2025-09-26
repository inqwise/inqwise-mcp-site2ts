import readline from 'node:readline';
import { crawl, CrawlParams } from './crawl.js';
import { analyze } from './analyze.js';
import { scaffold } from './scaffold.js';
import { generate } from './generate.js';
import { diff as doDiff } from './diff.js';
import { audit as doAudit } from './audit.js';
import { apply as doApply } from './apply.js';
import { assets as doAssets } from './assets.js';
import { pack as doPack } from './pack.js';
import { initRuntime } from './init.js';
import { improve as doImprove } from './improve.js';

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
  const resp: RpcResponse = ok
    ? { jsonrpc: '2.0', result: payload, id }
    : { jsonrpc: '2.0', error: payload as { code: number; message: string; data?: Json }, id };
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
    case 'diff': {
      const generationId = (params?.generationId as string) || '';
      const baselines = (params?.baselines as 'recrawl' | 'cached') || 'recrawl';
      const viewport = (params?.viewport as { w: number; h: number; deviceScale: number }) || {
        w: 1280,
        h: 800,
        deviceScale: 1,
      };
      const threshold = typeof params?.threshold === 'number' ? (params.threshold as number) : 0.01;
      const renderReport = Boolean(params?.renderReport ?? false);
      if (!generationId) throw Object.assign(new Error('generationId required'), { code: -32602 });
      return await doDiff(generationId, baselines, viewport, threshold, renderReport);
    }
    case 'improve': {
      const generationId = (params?.generationId as string) || '';
      if (!generationId) throw Object.assign(new Error('generationId required'), { code: -32602 });
      const route = params?.route as string | undefined;
      const issues = Array.isArray(params?.issues) ? (params.issues as string[]) : undefined;
      const instructions = typeof params?.instructions === 'string' ? (params.instructions as string) : undefined;
      const metadata = typeof params?.metadata === 'object' && params?.metadata !== null ? (params.metadata as Record<string, unknown>) : undefined;
      return await doImprove({ generationId, route, issues, instructions, metadata });
    }
    case 'audit': {
      const generationId = (params?.generationId as string) || '';
      const tsStrict = Boolean(params?.tsStrict ?? true);
      const eslintConfig = (params?.eslintConfig as string) || 'recommended';
      if (!generationId) throw Object.assign(new Error('generationId required'), { code: -32602 });
      return await doAudit(generationId, tsStrict, eslintConfig);
    }
    case 'apply': {
      const generationId = (params?.generationId as string) || '';
      const target = (params?.target as string) || './';
      const dryRun = Boolean(params?.dryRun ?? false);
      if (!generationId) throw Object.assign(new Error('generationId required'), { code: -32602 });
      return await doApply(generationId, target, dryRun);
    }
    case 'assets': {
      const id = (params?.siteMapId as string) || (params?.generationId as string) || '';
      if (!id) throw Object.assign(new Error('id required'), { code: -32602 });
      return await doAssets(id);
    }
    case 'pack': {
      const generationId = (params?.generationId as string) || '';
      if (!generationId) throw Object.assign(new Error('generationId required'), { code: -32602 });
      return await doPack(generationId);
    }
    case 'initRuntime': {
      return await initRuntime();
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
