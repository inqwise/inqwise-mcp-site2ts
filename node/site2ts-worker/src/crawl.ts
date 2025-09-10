import { chromium, devices } from 'playwright-core';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Minimatch } from 'minimatch';
import { XMLParser } from 'fast-xml-parser';
import { ulid } from 'ulid';

export type CrawlParams = {
  startUrl: string;
  sameOrigin: boolean;
  maxPages: number;
  maxDepth: number;
  allow: string[];
  deny: string[];
  concurrency: number;
  delayMs: number;
  useSitemap: boolean;
  obeyRobots: boolean;
};

export type PageEntry = { url: string; hash: string };

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

function normalizeUrl(u: string, base: URL): URL | null {
  try {
    const url = new URL(u, base);
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function buildMatchers(patterns: string[]): { test: (p: string) => boolean }[] {
  return patterns.map((p) => {
    if (p.startsWith('re:')) {
      const re = new RegExp(p.slice(3));
      return { test: (s: string) => re.test(s) };
    }
    // default: glob
    const mm = new Minimatch(p, { dot: true, nocase: false, nocomment: true });
    return { test: (s: string) => mm.match(s) };
  });
}

function allowedPath(pathname: string, allow: { test: (p: string) => boolean }[], deny: { test: (p: string) => boolean }[]) {
  if (deny.some((m) => m.test(pathname))) return false;
  if (allow.length === 0) return true;
  return allow.some((m) => m.test(pathname));
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function parseRobots(start: URL): Promise<string[]> {
  const txt = await fetchText(new URL('/robots.txt', start).toString());
  if (!txt) return [];
  const disallow: string[] = [];
  let inStar = false;
  for (const line of txt.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    if (/^user-agent:\s*\*/i.test(l)) {
      inStar = true;
      continue;
    }
    if (/^user-agent:/i.test(l)) {
      inStar = false;
      continue;
    }
    if (inStar) {
      const m = l.match(/^disallow:\s*(.*)$/i);
      if (m) disallow.push(m[1].trim() || '/');
    }
  }
  return disallow;
}

async function discoverSitemap(start: URL): Promise<string[]> {
  const xml = await fetchText(new URL('/sitemap.xml', start).toString());
  if (!xml) return [];
  try {
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const doc = parser.parse(xml);
    const entries: string[] = [];
    if (doc.urlset && Array.isArray(doc.urlset.url)) {
      for (const u of doc.urlset.url) {
        const loc = u.loc?.toString?.();
        if (loc) entries.push(loc);
      }
    } else if (doc.sitemapindex && Array.isArray(doc.sitemapindex.sitemap)) {
      // Nested sitemaps not followed for MVP
      for (const sm of doc.sitemapindex.sitemap) {
        const loc = sm.loc?.toString?.();
        if (loc) entries.push(loc);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

async function savePageArtifacts(baseDir: string, url: string): Promise<PageEntry> {
  const hash = sha1(url);
  const dir = path.join(baseDir, hash);
  await ensureDir(dir);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      recordHar: { path: path.join(dir, 'page.har') },
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    const html = await page.content();
    const title = await page.title();
    const headers = response?.headers() || {};
    await fs.writeFile(path.join(dir, 'page.html'), html);
    await page.screenshot({ path: path.join(dir, 'snap.png'), fullPage: true });
    await context.close();

    // Mobile snapshot
    const iPhone = devices['iPhone 13'];
    const mctx = await browser.newContext({ ...iPhone });
    const mp = await mctx.newPage();
    await mp.goto(url, { waitUntil: 'networkidle' });
    await mp.screenshot({ path: path.join(dir, 'snap.mobile.png'), fullPage: true });
    await mctx.close();

    const meta = { title, meta: {}, headers };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  } finally {
    await browser.close();
  }

  return { url, hash };
}

export async function crawl(params: CrawlParams): Promise<{ jobId: string; siteMapId: string; pages: PageEntry[] }> {
  const jobId = ulid();
  const siteMapId = ulid();
  const start = new URL(params.startUrl);
  const baseDir = path.join('.site2ts', 'cache', 'crawl');
  await ensureDir(baseDir);

  const allowMatchers = buildMatchers(params.allow || []);
  const denyMatchers = buildMatchers(params.deny || []);

  // robots.txt
  let robotsDisallow: string[] = [];
  if (params.obeyRobots) {
    try { robotsDisallow = await parseRobots(start); } catch { robotsDisallow = []; }
  }
  const robotsDeny = robotsDisallow.map((p) => new Minimatch(p.endsWith('*') ? p : p + '*'));

  const visited = new Set<string>();
  const queue: Array<{ url: URL; depth: number }> = [];
  const seedUrls: URL[] = [start];

  if (params.useSitemap) {
    try {
      const entries = await discoverSitemap(start);
      for (const e of entries) {
        const nu = normalizeUrl(e, start);
        if (nu) seedUrls.push(nu);
      }
    } catch {}
  }

  for (const u of seedUrls) {
    queue.push({ url: u, depth: 0 });
  }

  const pages: PageEntry[] = [];
  while (queue.length && pages.length < params.maxPages) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url.toString())) continue;
    visited.add(url.toString());

    // Scope checks
    if (params.sameOrigin && (url.origin !== start.origin)) continue;
    if (!allowedPath(url.pathname, allowMatchers, denyMatchers)) continue;
    if (robotsDeny.some((m) => m.match(url.pathname))) continue;

    // Save artifacts
    try {
      const entry = await savePageArtifacts(baseDir, url.toString());
      pages.push(entry);
    } catch {
      // ignore fetch failures for MVP
    }

    if (pages.length >= params.maxPages || depth >= params.maxDepth) continue;

    // Extract links from saved HTML to reduce repeated fetch
    try {
      const html = await fs.readFile(path.join(baseDir, sha1(url.toString()), 'page.html'), 'utf-8');
      const links = Array.from(html.matchAll(/href\s*=\s*"([^"]+)"/gi)).map((m) => m[1]);
      for (const href of links) {
        const nu = normalizeUrl(href, url);
        if (!nu) continue;
        if (visited.has(nu.toString())) continue;
        queue.push({ url: nu, depth: depth + 1 });
      }
    } catch {}

    if (params.delayMs > 0) await new Promise((r) => setTimeout(r, params.delayMs));
  }

  return { jobId, siteMapId, pages };
}
