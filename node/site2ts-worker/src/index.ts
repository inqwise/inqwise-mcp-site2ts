import readline from 'node:readline';
import { ulid } from 'ulid';
import { chromium, devices } from 'playwright-core';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

async function savePageArtifacts(baseDir: string, url: string): Promise<{ url: string; hash: string }> {
  const hash = sha1(url);
  const dir = path.join(baseDir, hash);
  await ensureDir(dir);

  // Desktop viewport
  const browser = await chromium.launch();
  const context = await browser.newContext({ recordHar: { path: path.join(dir, 'page.har') }, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: 'networkidle' });
  const html = await page.content();
  const title = await page.title();
  const headers = response?.headers() || {};
  await fs.writeFile(path.join(dir, 'page.html'), html);
  await page.screenshot({ path: path.join(dir, 'snap.png'), fullPage: true });
  await context.close();
  await browser.close();

  // Mobile snapshot (separate context)
  const iPhone = devices['iPhone 13'];
  const mb = await chromium.launch();
  const mctx = await mb.newContext({ ...iPhone });
  const mp = await mctx.newPage();
  await mp.goto(url, { waitUntil: 'networkidle' });
  await mp.screenshot({ path: path.join(dir, 'snap.mobile.png'), fullPage: true });
  await mctx.close();
  await mb.close();

  const meta = { title, meta: {}, headers };
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

  return { url, hash };
}

async function handleAsync(method: string, params: Json): Promise<Json> {
  switch (method) {
    case 'ping':
      return { ok: true, msg: 'site2ts-worker ready' };
    case 'crawl': {
      const jobId = ulid();
      const siteMapId = ulid();
      const startUrl = params?.startUrl as string;
      if (!startUrl) throw Object.assign(new Error('startUrl required'), { code: -32602 });

      const baseDir = path.join('.site2ts', 'cache', 'crawl');
      await ensureDir(baseDir);

      // MVP: fetch only startUrl (depth=0)
      const pageEntry = await savePageArtifacts(baseDir, startUrl);
      return { jobId, siteMapId, pages: [pageEntry] };
    }
    default:
      throw Object.assign(new Error('method not found'), { code: -32601 });
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
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
      const res = await handleAsync(req.method, req.params || {});
      respond(true, res, req.id);
    } catch (e: any) {
      respond(false, { code: e?.code ?? -32603, message: e?.message ?? 'internal error' }, req.id);
    }
  });
}

main();
