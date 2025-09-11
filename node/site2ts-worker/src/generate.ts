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

async function writePageTsx(
  appDir: string,
  route: string,
  bodyHtml: string,
  opts?: { withFallbackCss?: boolean },
) {
  const tsx = htmlToTsx(bodyHtml);
  const dir = path.join(appDir, routeToDir(route));
  await ensureDir(dir);
  const file = path.join(dir, 'page.tsx');
  const banner = `// TODO: tailwindify — fallback styling may be present\n`;
  const imports = opts?.withFallbackCss ? `import styles from './page.module.css'\n` : '';
  const mainClass = opts?.withFallbackCss ? ` className={styles.fallback}` : '';
  const contents = `${banner}${imports}export default function Page() {\n  return (\n    <main${mainClass}>\n      {/* Auto-generated content (MVP). Some inline styles may remain; see reports/tailwind/fallbacks.json */}\n      <>${tsx}</>\n    </main>\n  );\n}\n`;
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

export async function generate(_analysisId: string, _scaffoldId: string, _tailwindMode: string) {
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
  const fallbackReport: Array<{ route: string; unmappedInlineStyles: number }> = [];
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
      // Remove script tags (will add TODO separately if needed)
      $('script').remove();
      // Map inline styles to Tailwind utilities where feasible
      let unmappedCount = 0;
      const restStyles: string[] = [];
      $('[style]').each((_: number, el: any) => {
        const style = ($(el).attr('style') || '').trim();
        if (!style) return;
        const { tw, rest } = mapInlineStyleToTw(style);
        if (tw.length) {
          const existing = ($(el).attr('class') || '').trim();
          const merged = (existing ? existing + ' ' : '') + tw.join(' ');
          $(el).attr('class', merged);
        }
        if (rest) {
          $(el).attr('style', rest);
          unmappedCount += 1;
          restStyles.push(rest);
        } else {
          $(el).removeAttr('style');
        }
      });
      const bodyHtml = $('body').html() || '';
      await writePageTsx(appDir, r.route, bodyHtml, { withFallbackCss: unmappedCount > 0 });
      // Emit CSS module with TODOs when there are unmapped styles
      if (unmappedCount > 0) {
        const dir = path.join(appDir, routeToDir(r.route));
        const cssPath = path.join(dir, 'page.module.css');
        const header = [
          '/* Auto-generated CSS module for remaining styles */',
          '/* TODO: tailwindify — consider mapping these to utilities */',
          '.fallback {',
          '  /* Remaining inline styles were detected on elements within this page. */',
          '}',
          '',
        ].join('\n');
        const comments = restStyles.slice(0, 50).map((s) => `/* ${s} */`).join('\n');
        await fs.writeFile(cssPath, `${header}\n${comments}\n`);
      }
      fallbackReport.push({ route: r.route, unmappedInlineStyles: unmappedCount });
    } catch {
      // skip missing page.html
    }
  }

  // Track fallbacks
  const fallbacksPath = path.join('.site2ts', 'reports', 'tailwind', 'fallbacks.json');
  await ensureDir(path.dirname(fallbacksPath));
  await fs.writeFile(
    fallbacksPath,
    JSON.stringify({ routes: fallbackReport }, null, 2),
  );

  return { jobId, generationId };
}

function mapInlineStyleToTw(style: string): { tw: string[]; rest: string } {
  const entries = style
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const idx = p.indexOf(':');
      if (idx === -1) return null as any;
      const key = p.slice(0, idx).trim().toLowerCase();
      const val = p.slice(idx + 1).trim().toLowerCase();
      return [key, val] as const;
    })
    .filter(Boolean) as Array<readonly [string, string]>;
  const tw: string[] = [];
  const rest: Array<string> = [];

  const pxToTw: Record<number, string> = {
    0: '0',
    2: '0.5',
    4: '1',
    8: '2',
    12: '3',
    16: '4',
    20: '5',
    24: '6',
    32: '8',
    40: '10',
    48: '12',
    64: '16',
  };

  function mapSpacing(prefix: string, v: string) {
    const m = v.match(/^(\d+)(px)?$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (pxToTw[n]) tw.push(`${prefix}-${pxToTw[n]}`);
      else rest.push(`${prefix}: ${v}`);
      return;
    }
    if (v === '0') tw.push(`${prefix}-0`);
    else rest.push(`${prefix}: ${v}`);
  }

  for (const [k, v] of entries) {
    switch (k) {
      case 'margin':
        mapSpacing('m', v);
        break;
      case 'margin-top':
        mapSpacing('mt', v);
        break;
      case 'margin-right':
        mapSpacing('mr', v);
        break;
      case 'margin-bottom':
        mapSpacing('mb', v);
        break;
      case 'margin-left':
        mapSpacing('ml', v);
        break;
      case 'padding':
        mapSpacing('p', v);
        break;
      case 'padding-top':
        mapSpacing('pt', v);
        break;
      case 'padding-right':
        mapSpacing('pr', v);
        break;
      case 'padding-bottom':
        mapSpacing('pb', v);
        break;
      case 'padding-left':
        mapSpacing('pl', v);
        break;
      case 'display':
        if (v === 'flex') tw.push('flex');
        else if (v === 'block') tw.push('block');
        else if (v === 'inline-block') tw.push('inline-block');
        else rest.push(`${k}: ${v}`);
        break;
      case 'justify-content':
        if (v === 'flex-start') tw.push('justify-start');
        else if (v === 'center') tw.push('justify-center');
        else if (v === 'flex-end') tw.push('justify-end');
        else if (v === 'space-between') tw.push('justify-between');
        else if (v === 'space-around') tw.push('justify-around');
        else if (v === 'space-evenly') tw.push('justify-evenly');
        else rest.push(`${k}: ${v}`);
        break;
      case 'align-items':
        if (v === 'stretch') tw.push('items-stretch');
        else if (v === 'center') tw.push('items-center');
        else if (v === 'flex-start') tw.push('items-start');
        else if (v === 'flex-end') tw.push('items-end');
        else if (v === 'baseline') tw.push('items-baseline');
        else rest.push(`${k}: ${v}`);
        break;
      case 'text-align':
        if (v === 'left' || v === 'center' || v === 'right' || v === 'justify') tw.push(`text-${v}`);
        else rest.push(`${k}: ${v}`);
        break;
      case 'font-size': {
        const m = v.match(/^(\d+)(px)?$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n <= 12) tw.push('text-xs');
          else if (n <= 14) tw.push('text-sm');
          else if (n <= 16) tw.push('text-base');
          else if (n <= 18) tw.push('text-lg');
          else if (n <= 20) tw.push('text-xl');
          else rest.push(`${k}: ${v}`);
        } else {
          rest.push(`${k}: ${v}`);
        }
        break;
      }
      case 'font-weight':
        if (v === 'bold') tw.push('font-bold');
        else if (v === '600' || v === 'semibold') tw.push('font-semibold');
        else if (v === '500' || v === 'medium') tw.push('font-medium');
        else if (v === '300' || v === 'light') tw.push('font-light');
        else rest.push(`${k}: ${v}`);
        break;
      case 'gap':
        mapSpacing('gap', v);
        break;
      case 'color':
        if (v === 'black' || v === '#000' || v === '#000000') tw.push('text-black');
        else if (v === 'white' || v === '#fff' || v === '#ffffff') tw.push('text-white');
        else rest.push(`${k}: ${v}`);
        break;
      case 'background-color':
        if (v === 'black' || v === '#000' || v === '#000000') tw.push('bg-black');
        else if (v === 'white' || v === '#fff' || v === '#ffffff') tw.push('bg-white');
        else rest.push(`${k}: ${v}`);
        break;
      case 'border':
      case 'border-width':
        if (v === '1px' || v.startsWith('1px ')) tw.push('border');
        else rest.push(`${k}: ${v}`);
        break;
      case 'border-radius': {
        const m = v.match(/^(\d+)(px)?$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n <= 4) tw.push('rounded');
          else if (n <= 8) tw.push('rounded-md');
          else if (n <= 999) tw.push('rounded-lg');
          else rest.push(`${k}: ${v}`);
        } else if (v === '50%') tw.push('rounded-full');
        else rest.push(`${k}: ${v}`);
        break;
      }
      case 'width':
        if (v === '100%' || v === 'auto') tw.push('w-full');
        else rest.push(`${k}: ${v}`);
        break;
      case 'height':
        if (v === '100%' || v === 'auto') tw.push('h-full');
        else rest.push(`${k}: ${v}`);
        break;
      default:
        rest.push(`${k}: ${v}`);
    }
  }

  const twUnique = Array.from(new Set(tw));
  const restStr = rest.length ? rest.join('; ') : '';
  return { tw: twUnique, rest: restStr };
}
