import * as cheerio from 'cheerio';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

type Analysis = {
  routes: { route: string; sourceUrl: string; dynamic: boolean; params?: string[] }[];
  forms?: any[];
  assets?: { images?: string[]; fonts?: string[]; styles?: string[] };
};

function sha1(s: string) {
  return createHash('sha1').update(s).digest('hex');
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function routeToDir(route: string): string {
  if (route === '/' || route === '') return '';
  return route.replace(/^\//, '');
}

function htmlToTsx(html: string): string {
  // Very basic transform: class -> className, strip on* handlers, keep style as-is for now (fallback)
  let out = html
    .replace(/\sclass=/g, ' className=')
    .replace(/\son[a-zA-Z]+="[^"]*"/g, '') // remove inline handlers
    .replace(/\son[a-zA-Z]+=\{[^}]*\}/g, '');
  // Self-close common void elements if not already
  out = out.replace(/<img([^>]*)>(?!\s*<\/img>)/g, '<img$1 />');
  out = out.replace(/<br([^>]*)>(?!\s*<\/br>)/g, '<br$1 />');
  out = out.replace(/<hr([^>]*)>(?!\s*<\/hr>)/g, '<hr$1 />');
  return out;
}

async function writePageTsx(appDir: string, route: string, bodyHtml: string) {
  const tsx = htmlToTsx(bodyHtml);
  const dir = path.join(appDir, routeToDir(route));
  await ensureDir(dir);
  const file = path.join(dir, 'page.tsx');
  const banner = `// TODO: tailwindify — fallback styling may be present\n`;
  const contents = `${banner}export default function Page() {\n  return (\n    <main>\n      {/* Auto-generated content (MVP) */}\n      <>${tsx}</>\n    </main>\n  );\n}\n`;
  await fs.writeFile(file, contents, 'utf-8');
}

async function copyImages(appAssetsDir: string, images: string[] = []) {
  await ensureDir(appAssetsDir);
  const mapping: Record<string, string> = {};
  for (const url of images) {
    try {
      const u = new URL(url);
      const ext = path.extname(u.pathname) || '.img';
      const name = `${sha1(url)}${ext}`;
      const dest = path.join(appAssetsDir, name);
      const res = await fetch(url);
      if (!res.ok || !res.body) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(dest, buf);
      mapping[url] = path.join('(site2ts)', 'assets', name);
    } catch {
      // ignore download errors in MVP
    }
  }
  return mapping;
}

export async function generate(analysisId: string, _scaffoldId: string, _tailwindMode: string) {
  const jobId = ulid();
  const generationId = ulid();
  const stagingDir = path.join('.site2ts', 'staging');
  const appDir = path.join(stagingDir, 'app');
  const analysisPath = path.join(stagingDir, 'meta', 'analysis.json');
  // analysisId is recorded but we read from analysis.json in staging for MVP
  const raw = await fs.readFile(analysisPath, 'utf-8');
  const analysis: Analysis = JSON.parse(raw);

  // Copy images to app/(site2ts)/assets
  const assetsDir = path.join(appDir, '(site2ts)', 'assets');
  const imageMap = await copyImages(assetsDir, analysis.assets?.images || []);

  // For each route, read cached page HTML by sourceUrl
  for (const r of analysis.routes) {
    const hash = sha1(r.sourceUrl);
    const htmlPath = path.join('.site2ts', 'cache', 'crawl', hash, 'page.html');
    try {
      const html = await fs.readFile(htmlPath, 'utf-8');
      const $ = cheerio.load(html);
      // Update img src to local mapping when available
      $('img[src]').each((_: number, el: any) => {
        const src = $(el).attr('src');
        if (!src) return;
        const abs = new URL(src, r.sourceUrl).toString();
        const mapped = imageMap[abs];
        if (mapped) $(el).attr('src', `/${mapped}`);
      });
      const bodyHtml = $('body').html() || '';
      await writePageTsx(appDir, r.route, bodyHtml);
    } catch {
      // skip missing page.html
    }
  }

  // Track fallbacks (empty MVP placeholder)
  const fallbacksPath = path.join('.site2ts', 'reports', 'tailwind', 'fallbacks.json');
  await ensureDir(path.dirname(fallbacksPath));
  await fs.writeFile(fallbacksPath, JSON.stringify({ pages: analysis.routes.map((r) => r.route) }, null, 2));

  return { jobId, generationId };
}

