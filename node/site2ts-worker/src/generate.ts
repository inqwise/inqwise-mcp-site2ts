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
      case 'flex-direction':
        if (v === 'row') tw.push('flex-row');
        else if (v === 'row-reverse') tw.push('flex-row-reverse');
        else if (v === 'column') tw.push('flex-col');
        else if (v === 'column-reverse') tw.push('flex-col-reverse');
        else rest.push(`${k}: ${v}`);
        break;
      case 'flex-wrap':
        if (v === 'nowrap') tw.push('flex-nowrap');
        else if (v === 'wrap') tw.push('flex-wrap');
        else if (v === 'wrap-reverse') tw.push('flex-wrap-reverse');
        else rest.push(`${k}: ${v}`);
        break;
      case 'align-self':
        if (v === 'auto') tw.push('self-auto');
        else if (v === 'start' || v === 'flex-start') tw.push('self-start');
        else if (v === 'center') tw.push('self-center');
        else if (v === 'end' || v === 'flex-end') tw.push('self-end');
        else if (v === 'stretch') tw.push('self-stretch');
        else rest.push(`${k}: ${v}`);
        break;
      case 'order': {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) tw.push(`order-${n}`);
        else rest.push(`${k}: ${v}`);
        break;
      }
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
      case 'font-style':
        if (v === 'italic') tw.push('italic');
        else if (v === 'normal') tw.push('not-italic');
        else rest.push(`${k}: ${v}`);
        break;
      case 'gap':
        mapSpacing('gap', v);
        break;
      case 'color':
        if (v === 'black' || v === '#000' || v === '#000000') tw.push('text-black');
        else if (v === 'white' || v === '#fff' || v === '#ffffff') tw.push('text-white');
        else if (v === '#333' || v === '#333333') tw.push('text-gray-800');
        else if (v === '#666' || v === '#666666') tw.push('text-gray-600');
        else if (v === '#999' || v === '#999999') tw.push('text-gray-500');
        else rest.push(`${k}: ${v}`);
        break;
      case 'background-color':
        if (v === 'black' || v === '#000' || v === '#000000') tw.push('bg-black');
        else if (v === 'white' || v === '#fff' || v === '#ffffff') tw.push('bg-white');
        else if (v === '#333' || v === '#333333') tw.push('bg-gray-800');
        else if (v === '#666' || v === '#666666') tw.push('bg-gray-600');
        else if (v === '#999' || v === '#999999') tw.push('bg-gray-500');
        else rest.push(`${k}: ${v}`);
        break;
      case 'border-color':
        if (v === 'black' || v === '#000' || v === '#000000') tw.push('border-black');
        else if (v === 'white' || v === '#fff' || v === '#ffffff') tw.push('border-white');
        else if (v === '#333' || v === '#333333') tw.push('border-gray-800');
        else if (v === '#666' || v === '#666666') tw.push('border-gray-600');
        else if (v === '#999' || v === '#999999') tw.push('border-gray-500');
        else rest.push(`${k}: ${v}`);
        break;
      case 'border':
      case 'border-width':
        if (v === '1px' || v.startsWith('1px ')) tw.push('border');
        else rest.push(`${k}: ${v}`);
        break;
      case 'border-style':
        if (v === 'solid') tw.push('border-solid');
        else if (v === 'dashed') tw.push('border-dashed');
        else if (v === 'dotted') tw.push('border-dotted');
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
      case 'min-width':
        if (v === '100%') tw.push('min-w-full');
        else rest.push(`${k}: ${v}`);
        break;
      case 'min-height':
        if (v === '100%') tw.push('min-h-full');
        else rest.push(`${k}: ${v}`);
        break;
      case 'overflow':
        if (v === 'hidden') tw.push('overflow-hidden');
        else if (v === 'auto') tw.push('overflow-auto');
        else if (v === 'scroll') tw.push('overflow-scroll');
        else rest.push(`${k}: ${v}`);
        break;
      case 'position':
        if (v === 'relative') tw.push('relative');
        else if (v === 'absolute') tw.push('absolute');
        else if (v === 'fixed') tw.push('fixed');
        else if (v === 'sticky') tw.push('sticky');
        else rest.push(`${k}: ${v}`);
        break;
      case 'top':
        mapSpacing('top', v);
        break;
      case 'left':
        mapSpacing('left', v);
        break;
      case 'right':
        mapSpacing('right', v);
        break;
      case 'bottom':
        mapSpacing('bottom', v);
        break;
      case 'text-transform':
        if (v === 'uppercase' || v === 'lowercase' || v === 'capitalize') tw.push(v);
        else if (v === 'none') tw.push('normal-case');
        else rest.push(`${k}: ${v}`);
        break;
      case 'text-decoration':
        if (v.includes('underline')) tw.push('underline');
        else if (v === 'none') tw.push('no-underline');
        else rest.push(`${k}: ${v}`);
        break;
      case 'letter-spacing':
        if (v === 'normal' || v === '0' || v === '0px') tw.push('tracking-normal');
        else if (v.endsWith('px')) tw.push('tracking-wide');
        else rest.push(`${k}: ${v}`);
        break;
      case 'line-height':
        if (v === 'normal') tw.push('leading-normal');
        else if (v === '1') tw.push('leading-none');
        else rest.push(`${k}: ${v}`);
        break;
      case 'opacity': {
        const n = parseFloat(v);
        if (!Number.isNaN(n)) {
          const pct = Math.round(n <= 1 ? n * 100 : n);
          // clamp to Tailwind's typical steps
          const step = [0,5,10,20,25,30,40,50,60,70,75,80,90,95,100].reduce((a,b)=>Math.abs(b-pct)<Math.abs(a-pct)?b:a,0);
          tw.push(`opacity-${step}`);
        } else rest.push(`${k}: ${v}`);
        break;
      }
      case 'z-index': {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) {
          const allowed = [0,10,20,30,40,50];
          const step = allowed.reduce((a,b)=>Math.abs(b-n)<Math.abs(a-n)?b:a,0);
          tw.push(`z-${step}`);
        } else rest.push(`${k}: ${v}`);
        break;
      }
      case 'background-repeat':
        if (v === 'no-repeat') tw.push('bg-no-repeat');
        else rest.push(`${k}: ${v}`);
        break;
      case 'background-size':
        if (v === 'cover') tw.push('bg-cover');
        else if (v === 'contain') tw.push('bg-contain');
        else rest.push(`${k}: ${v}`);
        break;
      case 'object-fit':
        if (v === 'cover') tw.push('object-cover');
        else if (v === 'contain') tw.push('object-contain');
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
