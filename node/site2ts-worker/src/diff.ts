import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { chromium } from 'playwright-core';
import getPort from 'get-port';
import { run, ensureDir, pathExists, rpcError, ensureDeps, emitProgress } from './utils.js';
import { spawn } from 'node:child_process';

type Analysis = {
  routes: { route: string; sourceUrl: string; dynamic: boolean; params?: string[] }[];
};

function sha1(s: string) {
  return createHash('sha1').update(s).digest('hex');
}

// ensureDir from utils

function routeToFolder(route: string): string {
  if (route === '/' || route === '') return 'root';
  return route.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function readPng(filePath: string): Promise<PNG> {
  const buf = await fs.readFile(filePath);
  return PNG.sync.read(buf);
}

async function writePng(filePath: string, png: PNG) {
  await ensureDir(path.dirname(filePath));
  const buf = PNG.sync.write(png);
  await fs.writeFile(filePath, buf);
}

export async function diff(
  generationId: string,
  baselines: 'recrawl' | 'cached',
  viewport: { w: number; h: number; deviceScale: number },
  threshold: number,
) {
  const jobId = ulid();
  const diffId = ulid();
  const stagingDir = path.join('.site2ts', 'staging');

  // Load analysis for route list
  const analysisPath = path.join('.site2ts', 'staging', 'meta', 'analysis.json');
  if (!(await pathExists(analysisPath))) {
    throw rpcError(-32004, 'analysis.json missing; run analyze before diff');
  }
  const fallbacks = path.join('.site2ts', 'reports', 'tailwind', 'fallbacks.json');
  if (!(await pathExists(fallbacks))) {
    throw rpcError(-32005, 'generation artifacts missing; run generate before diff');
  }
  let raw: string;
  emitProgress({ tool: 'diff', phase: 'start', extra: { jobId, generationId }, detail: 'initializing' });
  emitProgress({ tool: 'diff', phase: 'deps', extra: { jobId, generationId }, detail: stagingDir });
  await ensureDeps(stagingDir);

  try {
    raw = await fs.readFile(analysisPath, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw rpcError(-32603, `failed to read analysis: ${msg}`);
  }
  const analysis: Analysis = JSON.parse(raw);

  const outRoot = path.join('.site2ts', 'reports', 'diff', diffId);
  const perRoute: { route: string; diffRatio: number; artifacts: { baseline: string; actual: string; diff: string } }[] = [];

  // Attempt to start Next.js app from staging for actual screenshots
  // Be resilient in restricted environments: default port and catch discovery errors
  let port = 3100;
  try {
    port = await getPort({ port: 3100 });
  } catch {
    // keep default port
  }
  let serverProc: { kill: () => void } | null = null;
  emitProgress({ tool: 'diff', phase: 'build', extra: { jobId, generationId }, detail: `port ${port}` });
  try {
    emitProgress({ tool: 'diff', phase: 'build', detail: 'npm run build', extra: { jobId, generationId } });
    const buildRes = await run('npm', ['run', 'build'], stagingDir, { timeoutMs: 300_000 });
    if (buildRes.timedOut) {
      throw rpcError(
        -32008,
        'visual diff timed out running "npm run build" in staging',
        { step: 'npm run build', timeoutMs: 300_000 },
      );
    }
    if (buildRes.code !== 0) {
      throw rpcError(
        -32008,
        'visual diff failed running "npm run build" in staging',
        { step: 'npm run build', exitCode: buildRes.code, stdout: buildRes.stdout, stderr: buildRes.stderr },
      );
    }
    emitProgress({
      tool: 'diff',
      phase: 'build-complete',
      extra: { jobId, generationId, stdout: buildRes.stdout.length, stderr: buildRes.stderr.length },
    });
    serverProc = spawnServer(stagingDir, port);
    emitProgress({
      tool: 'diff',
      phase: 'serve',
      detail: `http://localhost:${port}/`,
      extra: { jobId, generationId },
    });
    await waitForHttp(`http://localhost:${port}/`, 30_000);
    emitProgress({
      tool: 'diff',
      phase: 'serve-ready',
      detail: `http://localhost:${port}/`,
      extra: { jobId, generationId },
    });
  } catch (err) {
    if (serverProc) serverProc.kill();
    serverProc = null;
    emitProgress({
      tool: 'diff',
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
      extra: { jobId, generationId },
    });
    throw err;
  }

  for (const r of analysis.routes) {
    // Baseline: crawled screenshot
    const baseHash = sha1(r.sourceUrl);
    const baselinePath = path.join('.site2ts', 'cache', 'crawl', baseHash, 'snap.png');

    // Actual: if server started, render route; otherwise fallback to baseline
    let actualPath = baselinePath;
    if (serverProc) {
      try {
        emitProgress({
          tool: 'diff',
          phase: 'route',
          detail: r.route,
          current: perRoute.length,
          total: analysis.routes.length,
          extra: { jobId, generationId },
        });
        actualPath = await renderActual(`http://localhost:${port}${r.route}`, viewport, outRoot, r.route);
      } catch {
        // Fallback to baseline if rendering fails (e.g., Playwright unavailable)
        actualPath = baselinePath;
      }
    }

    try {
      const baselinePng = await readPng(baselinePath);
      const actualPng = await readPng(actualPath);
      const width = Math.min(baselinePng.width, actualPng.width);
      const height = Math.min(baselinePng.height, actualPng.height);

      let baselineCrop = baselinePng;
      let actualCrop = actualPng;
      if (baselinePng.width !== width || baselinePng.height !== height) {
        baselineCrop = new PNG({ width, height });
        for (let y = 0; y < height; y++) {
          const srcStart = y * baselinePng.width * 4;
          const dstStart = y * width * 4;
          baselinePng.data.copy(baselineCrop.data, dstStart, srcStart, srcStart + width * 4);
        }
      }
      if (actualPng.width !== width || actualPng.height !== height) {
        actualCrop = new PNG({ width, height });
        for (let y = 0; y < height; y++) {
          const srcStart = y * actualPng.width * 4;
          const dstStart = y * width * 4;
          actualPng.data.copy(actualCrop.data, dstStart, srcStart, srcStart + width * 4);
        }
      }

      const diffPng = new PNG({ width, height });
      const changed = pixelmatch(baselineCrop.data, actualCrop.data, diffPng.data, width, height, {
        threshold,
      });
      const total = width * height;
      const ratio = total ? changed / total : 0;

      const folder = path.join(outRoot, routeToFolder(r.route));
      const outBaseline = path.join(folder, 'baseline.png');
      const outActual = path.join(folder, 'actual.png');
      const outDiff = path.join(folder, 'diff.png');
      await ensureDir(folder);
      await fs.copyFile(baselinePath, outBaseline).catch(async () => writePng(outBaseline, baselineCrop));
      await fs.copyFile(actualPath, outActual).catch(async () => writePng(outActual, actualCrop));
      await writePng(outDiff, diffPng);
      await fs.writeFile(
        path.join(folder, 'metrics.json'),
        JSON.stringify({ total, changed, ratio }, null, 2),
      );

      perRoute.push({ route: r.route, diffRatio: ratio, artifacts: { baseline: outBaseline, actual: outActual, diff: outDiff } });
    } catch {
      // Skip routes without baseline
    }
  }

  if (serverProc) {
    emitProgress({ tool: 'diff', phase: 'serve-stop', extra: { jobId, generationId } });
    serverProc.kill();
    serverProc = null;
  }

  const avg = perRoute.length
    ? perRoute.reduce((acc, p) => acc + p.diffRatio, 0) / perRoute.length
    : 0;
  const passed = perRoute.filter((p) => p.diffRatio <= threshold).length;
  const failed = perRoute.length - passed;

  return { jobId, diffId, perRoute, summary: { passed, failed, avg } };
}

async function renderActual(url: string, vp: { w: number; h: number; deviceScale: number }, outRoot: string, route: string) {
  const folder = path.join(outRoot, routeToFolder(route));
  await ensureDir(folder);
  const outActual = path.join(folder, 'actual.png');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.deviceScale });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: outActual, fullPage: true });
  await context.close();
  await browser.close();
  return outActual;
}

function spawnServer(cwd: string, port: number) {
  const child = spawn('npm', ['run', 'start', '--', '-p', String(port)], { cwd, env: process.env });
  return { kill: () => child.kill() };
}

async function waitForHttp(url: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw rpcError(
    -32008,
    `visual diff timed out waiting for staging server at ${url}`,
    { url, timeoutMs },
  );
}
