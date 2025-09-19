import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { emitProgress, pathExists, rpcError } from './utils.js';

type SiteMap = {
  siteMapId: string;
  pages: { url: string; hash: string }[];
};

export type AnalyzeResult = {
  jobId: string;
  analysisId: string;
  routes: { route: string; sourceUrl: string; dynamic: boolean; params?: string[] }[];
  forms: { route: string; method: string; fields: string[] }[];
  assets: { images: string[]; fonts: string[]; styles: string[] };
};

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

export async function analyze(siteMapId: string): Promise<AnalyzeResult> {
  const jobId = ulid();
  const analysisId = ulid();
  const sitemapPath = path.join('.site2ts', 'cache', 'sitemaps', `${siteMapId}.json`);
  if (!(await pathExists(sitemapPath))) {
    throw rpcError(-32001, `siteMapId ${siteMapId} not found; run crawl first`);
  }
  let raw: string;
  try {
    raw = await fs.readFile(sitemapPath, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw rpcError(-32603, `failed to read sitemap: ${msg}`);
  }
  const sm = JSON.parse(raw) as SiteMap;

  emitProgress({ tool: 'analyze', phase: 'start', extra: { jobId, siteMapId } });

  const routes: AnalyzeResult['routes'] = [];
  const forms: AnalyzeResult['forms'] = [];
  const images = new Set<string>();
  const fonts = new Set<string>();
  const styles = new Set<string>();

  for (const p of sm.pages || []) {
    const u = new URL(p.url);
    const route = u.pathname || '/';
    routes.push({ route, sourceUrl: p.url, dynamic: false });

    const htmlPath = path.join('.site2ts', 'cache', 'crawl', p.hash || sha1(p.url), 'page.html');
    try {
      const html = await fs.readFile(htmlPath, 'utf-8');
      const $ = cheerio.load(html);

      $('form').each((_: number, el: any) => {
        const method = ($(el).attr('method') || 'GET').toUpperCase();
        const fields = new Set<string>();
        $(el)
          .find('input[name], select[name], textarea[name]')
          .each((__: number, fld: any) => {
            const name = $(fld).attr('name');
            if (name) fields.add(name);
          });
        forms.push({ route, method, fields: Array.from(fields) });
      });

      $('img[src]').each((_: number, img: any) => {
        const src = $(img).attr('src');
        if (src) images.add(new URL(src, u).toString());
      });
      $('link[rel="stylesheet"][href]').each((_: number, l: any) => {
        const href = $(l).attr('href');
        if (href) styles.add(new URL(href, u).toString());
      });
      $('link[rel="preload"][as="font"][href]').each((_: number, l: any) => {
        const href = $(l).attr('href');
        if (href) fonts.add(new URL(href, u).toString());
      });
    } catch {
      // skip unreadable pages
    }
  }

  emitProgress({
    tool: 'analyze',
    phase: 'complete',
    current: routes.length,
    total: sm.pages?.length || 0,
    extra: { jobId, analysisId },
  });

  return {
    jobId,
    analysisId,
    routes,
    forms,
    assets: { images: Array.from(images), fonts: Array.from(fonts), styles: Array.from(styles) },
  };
}
