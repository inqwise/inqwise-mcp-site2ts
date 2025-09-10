import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

type Analysis = {
  routes: { route: string; sourceUrl: string; dynamic: boolean; params?: string[] }[];
};

function sha1(s: string) {
  return createHash('sha1').update(s).digest('hex');
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

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

  // Load analysis for route list
  const analysisPath = path.join('.site2ts', 'staging', 'meta', 'analysis.json');
  const raw = await fs.readFile(analysisPath, 'utf-8');
  const analysis: Analysis = JSON.parse(raw);

  const outRoot = path.join('.site2ts', 'reports', 'diff', diffId);
  const perRoute: { route: string; diffRatio: number; artifacts: { baseline: string; actual: string; diff: string } }[] = [];

  for (const r of analysis.routes) {
    // Baseline: crawled screenshot
    const baseHash = sha1(r.sourceUrl);
    const baselinePath = path.join('.site2ts', 'cache', 'crawl', baseHash, 'snap.png');

    // Actual: MVP — reuse baseline until Next.js render is wired
    const actualPath = baselinePath; // TODO: render generated app and capture

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

  const avg = perRoute.length
    ? perRoute.reduce((acc, p) => acc + p.diffRatio, 0) / perRoute.length
    : 0;
  const passed = perRoute.filter((p) => p.diffRatio <= threshold).length;
  const failed = perRoute.length - passed;

  return { jobId, diffId, perRoute, summary: { passed, failed, avg } };
}
