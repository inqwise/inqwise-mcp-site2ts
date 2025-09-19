import * as cheerio from 'cheerio';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { emitProgress, pathExists, rpcError } from './utils.js';

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

function escapeForTemplateLiteral(html: string): string {
  return html.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

async function writePageTsx(
  appDir: string,
  route: string,
  bodyHtml: string,
  opts?: { withFallbackCss?: boolean },
) {
  // Instead of embedding raw TSX for complex third-party markup, inject as HTML string
  const safe = escapeForTemplateLiteral(bodyHtml);
  const dir = path.join(appDir, routeToDir(route));
  await ensureDir(dir);
  const file = path.join(dir, 'page.tsx');
  const banner = `// TODO: tailwindify — fallback styling may be present\n`;
  const imports = opts?.withFallbackCss ? `import styles from './page.module.css'\n` : '';
  const mainClass = opts?.withFallbackCss ? ` className={styles.fallback}` : '';
  const contents = `${banner}${imports}export default function Page() {\n  return (\n    <main${mainClass}>\n      {/* Auto-generated content (MVP). Some inline styles may remain; see reports/tailwind/fallbacks.json */}\n      <div dangerouslySetInnerHTML={{ __html: \`${safe}\` }} />\n    </main>\n  );\n}\n`;
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
  if (!(await pathExists(path.join(stagingDir, 'package.json')))) {
    throw rpcError(-32003, 'scaffold output missing; run scaffold before generate');
  }
  if (!(await pathExists(analysisPath))) {
    throw rpcError(-32002, 'analysis.json missing; run analyze before generate');
  }
  let raw: string;
  try {
    raw = await fs.readFile(analysisPath, 'utf-8');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw rpcError(-32603, `failed to read analysis: ${msg}`);
  }
  const analysis: Analysis = JSON.parse(raw);

  // Copy images to app/(site2ts)/assets
  const assetsDir = path.join(appDir, '(site2ts)', 'assets');
  const imageMap = await copyImages(assetsDir, analysis.assets?.images || []);

  let capturedBodyClass: string | null = null;
  let capturedHtmlLang: string | null = null;
  let capturedHtmlDir: string | null = null;

  emitProgress({ tool: 'generate', phase: 'start', extra: { jobId, generationId }, total: analysis.routes.length });

  // For each route, read cached page HTML by sourceUrl
  const fallbackReport: Array<{ route: string; unmappedInlineStyles: number }> = [];
  const inlineCssChunks = new Set<string>();
  const stylesheetUrls = new Set<string>();
  const cssVariables = new Map<string, string>();
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
      convertWowImages($);
      const sourceOrigin = new URL(r.sourceUrl).origin;
      $('a[href]').each((_: number, el: any) => {
        const href = $(el).attr('href');
        if (!href) return;
        const trimmed = href.trim();
        if (!trimmed || trimmed.startsWith('#') || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) return;
        try {
          const parsed = new URL(trimmed, r.sourceUrl);
          if (parsed.origin !== sourceOrigin) return;
          const relative = `${parsed.pathname || '/'}` + `${parsed.search || ''}` + `${parsed.hash || ''}`;
          $(el).attr('href', relative || '/');
        } catch {
          /* ignore invalid URLs */
        }
      });
      if (capturedBodyClass === null) {
        capturedBodyClass = collapseWhitespace($('body').attr('class') || '');
        capturedHtmlLang = $('html').attr('lang') || null;
        capturedHtmlDir = $('html').attr('dir') || null;
      }
      // Unhide elements that Wix keeps hidden until JS warms up
      $('.hidden-during-prewarmup').each((_: number, el: any) => {
        const cls = $(el).attr('class');
        if (cls) {
          const nextCls = cls
            .split(/\s+/)
            .filter((token: string) => token && token !== 'hidden-during-prewarmup')
            .join(' ');
          $(el).attr('class', nextCls);
        }
        const style = $(el).attr('style');
        if (style) {
          const filtered = style
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s && !/^visibility\s*:/i.test(s) && !/^opacity\s*:/i.test(s))
            .join('; ');
          if (filtered) $(el).attr('style', filtered);
          else $(el).removeAttr('style');
        }
      });
      $('link[rel="stylesheet"][href], link[rel="preload"][as="style"][href]').each((_: number, el: any) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const abs = new URL(href, r.sourceUrl).toString();
          stylesheetUrls.add(abs);
        } catch {
          /* ignore */
        }
      });
      $('style').each((_: number, el: any) => {
        const css = $(el).html();
        if (css?.trim()) {
          const chunk = css.trim();
          collectCssVariables(chunk, cssVariables);
          inlineCssChunks.add(chunk);
        }
      });
      // Remove script tags (will add TODO separately if needed)
      $('script').remove();
      // Track inline styles; keep them verbatim for fidelity, just catalog for reporting.
      // Map inline styles to Tailwind utilities where feasible
      let unmappedCount = 0;
      const restStyles: string[] = [];
      $('[style]').each((_: number, el: any) => {
        const originalStyle = ($(el).attr('style') || '').trim();
        if (!originalStyle) return;
        const { tw, rest } = mapInlineStyleToTw(originalStyle);
        if (tw.length) {
          const existing = ($(el).attr('class') || '').trim();
          const mergedSet = new Set(existing ? existing.split(/\s+/).filter(Boolean) : []);
          for (const cls of tw) mergedSet.add(cls);
          $(el).attr('class', Array.from(mergedSet).join(' '));
        }

        const fallbackFragments: string[] = [];
        const synthesizedFragments: string[] = [];
        if (rest) {
          for (const fragment of rest.split(';')) {
            const trimmed = fragment.trim();
            if (!trimmed) continue;
            const idx = trimmed.indexOf(':');
            if (idx === -1) {
              fallbackFragments.push(trimmed);
              continue;
            }
            const key = trimmed.slice(0, idx).trim();
            const value = trimmed.slice(idx + 1).trim();
            const conversions = convertCustomProperty(key, value, cssVariables);
            if (conversions.length) synthesizedFragments.push(...conversions);
            else fallbackFragments.push(trimmed);
          }
        }

        const combinedFragments = [...synthesizedFragments, ...fallbackFragments];
        if (combinedFragments.length) {
          $(el).attr('style', combinedFragments.join('; '));
        } else {
          $(el).removeAttr('style');
        }

        if (fallbackFragments.length) {
          unmappedCount += fallbackFragments.length;
          restStyles.push(...fallbackFragments);
        }
      });
      // Strip inline event handlers (e.g., onclick) before serialization for safety.
      $('*').each((_: number, el: any) => {
        const attribs = el.attribs || {};
        for (const attr of Object.keys(attribs)) {
          if (/^on[a-z]+/i.test(attr)) {
            $(el).removeAttr(attr);
          }
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
      emitProgress({
        tool: 'generate',
        phase: 'route',
        detail: r.route,
        current: fallbackReport.length,
        total: analysis.routes.length,
        extra: { jobId, generationId, unmappedInlineStyles: unmappedCount },
      });
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

  // Capture external styles so the app renders without runtime scripts
  const externalCss: string[] = [];
  for (const css of inlineCssChunks) {
    externalCss.push(normalizeExternalCss(css, cssVariables));
  }
  for (const url of stylesheetUrls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim()) {
        const chunk = text.trim();
        collectCssVariables(chunk, cssVariables);
        externalCss.push(normalizeExternalCss(chunk, cssVariables));
      }
    } catch {
      // ignore download failures
    }
  }
  if (externalCss.length) {
    const globalsPath = path.join(appDir, 'globals.css');
    const existing = await fs.readFile(globalsPath, 'utf-8');
    const merged = `${existing}\n/* External styles captured from source site */\n${externalCss.join('\n\n')}\n`;
    await fs.writeFile(globalsPath, merged, 'utf-8');
  }

  await writeLayout(appDir, {
    bodyClass: capturedBodyClass,
    htmlLang: capturedHtmlLang,
    htmlDir: capturedHtmlDir,
  });

  emitProgress({ tool: 'generate', phase: 'complete', extra: { jobId, generationId } });

  return { jobId, generationId };
}

function convertWowImages($: cheerio.CheerioAPI) {
  const alignMap: Record<string, string> = {
    center: '50% 50%',
    left: '0% 50%',
    right: '100% 50%',
    top: '50% 0%',
    bottom: '50% 100%',
    top_left: '0% 0%',
    top_right: '100% 0%',
    bottom_left: '0% 100%',
    bottom_right: '100% 100%',
  };

  $('wow-image').each((_: number, node: any) => {
    const el = $(node);
    const parent = el.parent();
    if (!parent.length) {
      el.remove();
      return;
    }

    const img = el.find('img').first();
    let src = img.attr('src') || '';

    const infoRaw = el.attr('data-image-info');
    let alignType: string | undefined;
    let displayMode: string | undefined;
    if (infoRaw) {
      try {
        const parsed = JSON.parse(infoRaw);
        alignType = parsed?.alignType || parsed?.alignment;
        displayMode = parsed?.displayMode || parsed?.imageData?.displayMode;
        const uri = parsed?.imageData?.uri;
        if (!src && uri) {
          src = `https://static.wixstatic.com/media/${uri}`;
        }
      } catch {
        /* ignore parse failures */
      }
    }

    if (!src) {
      el.replaceWith(el.html() || '');
      return;
    }

    const additions: Record<string, string> = {
      'background-image': `url('${src}')`,
      'background-repeat': 'no-repeat',
    };
    additions['background-size'] = displayMode === 'fit' ? 'contain' : 'cover';
    additions['background-position'] = alignType && alignMap[alignType] ? alignMap[alignType] : '50% 50%';

    const merged = mergeStyleString(parent.attr('style'), additions);
    parent.attr('style', merged);
    el.remove();
  });
}

function collapseWhitespace(input: string): string {
  return input.split(/\s+/).filter(Boolean).join(' ');
}

function mergeStyleString(existing: string | undefined, additions: Record<string, string>): string {
  const map = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(':');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim().toLowerCase();
      const value = trimmed.slice(idx + 1).trim();
      if (key) map.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(additions)) {
    const k = key.trim().toLowerCase();
    const v = value.trim();
    if (!k || !v) continue;
    map.set(k, v);
  }
  const serialized = Array.from(map.entries())
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
  return serialized ? `${serialized};` : '';
}

async function writeLayout(
  appDir: string,
  opts: { bodyClass: string | null; htmlLang: string | null; htmlDir: string | null },
) {
  const layoutPath = path.join(appDir, 'layout.tsx');
  const lang = opts.htmlLang || 'en';
  const dirAttr = opts.htmlDir ? ` dir=${JSON.stringify(opts.htmlDir)}` : '';
  const bodyClass = opts.bodyClass && opts.bodyClass.length > 0
    ? collapseWhitespace(opts.bodyClass)
    : 'min-h-screen bg-white text-gray-900';
  const layout = `import './globals.css'\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=${JSON.stringify(lang)}${dirAttr}>\n      <body className=${JSON.stringify(bodyClass)}>\n        {children}\n      </body>\n    </html>\n  );\n}\n`;
  await fs.writeFile(layoutPath, layout, 'utf-8');
}

function normalizeExternalCss(css: string, vars: Map<string, string>): string {
  return css
    .replace(/}(?=[^\s])/g, '}\n')
    .replace(/;\);/g, ';)')
    .replace(/--([a-z0-9_-]+)\s+-/gi, (m, g1) => `--${g1}-`)
    .replace(/--([a-z0-9_-]+)-\s+/gi, (m, g1) => `--${g1}-`)
    .replace(/(--[a-z0-9_-]+\s*:\s*)([^;]+);/gi, (m, prefix, value) => {
      const normalized = sanitizeCustomPropertyValue(value);
      return `${prefix}${normalized};`;
    })
    .replace(/rgba\(\s*var\(--([a-z0-9_-]+)\)\s*,\s*([^)]+)\)/gi, (m, name, alpha) => {
      const resolved = resolveCssVar(name, vars);
      if (!resolved) return m;
      const components = extractColorComponents(resolved);
      if (!components) return m;
      const [r, g, b, a] = components;
      const finalAlpha = typeof a === 'number' ? a : parseFloat(alpha.trim());
      if (Number.isNaN(finalAlpha)) return m;
      return `rgba(${r}, ${g}, ${b}, ${finalAlpha})`;
    })
    .replace(/rgb\(\s*var\(--([a-z0-9_-]+)\)\s*\)/gi, (m, name) => {
      const resolved = resolveCssVar(name, vars);
      if (!resolved) return m;
      const components = extractColorComponents(resolved);
      if (!components) return resolved;
      const [r, g, b, a] = components;
      if (typeof a === 'number') return `rgba(${r}, ${g}, ${b}, ${a})`;
      return `rgb(${r}, ${g}, ${b})`;
    });
}

function collectCssVariables(css: string, vars: Map<string, string>) {
  const re = /--([a-z0-9_-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    vars.set(match[1], match[2].trim());
  }
}

function resolveCssVar(name: string, vars: Map<string, string>): string | null {
  const raw = vars.get(name);
  if (!raw) return null;
  const trimmed = raw.trim();
  const components = extractColorComponents(trimmed);
  if (components) {
    const [r, g, b, a] = components;
    if (typeof a === 'number') return `rgba(${r}, ${g}, ${b}, ${a})`;
    return `rgb(${r}, ${g}, ${b})`;
  }
  return trimmed;
}

function extractColorComponents(value: string): [number, number, number, number?] | null {
  const normalized = value.trim();
  const important = normalized.endsWith('!important');
  const cleaned = important ? normalized.slice(0, -10).trim() : normalized;

  const rgbMatch = cleaned.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.every((n) => !Number.isNaN(n))) {
      if (parts.length === 4) {
        return [parts[0], parts[1], parts[2], parts[3]];
      }
      const base: [number, number, number] = [parts[0], parts[1], parts[2]];
      if (important) return [base[0], base[1], base[2], 1];
      return base;
    }
  }

  const numericParts = cleaned.split(',').map((p) => p.trim());
  if (numericParts.length === 3 || numericParts.length === 4) {
    const numbers = numericParts.map((p) => parseFloat(p));
    if (numbers.every((n) => !Number.isNaN(n))) {
      return numericParts.length === 4
        ? [numbers[0], numbers[1], numbers[2], numbers[3]]
        : [numbers[0], numbers[1], numbers[2]];
    }
  }

  if (/^#[0-9a-f]{3,8}$/i.test(cleaned)) {
    const hex = cleaned.replace('#', '');
    if (hex.length === 6 || hex.length === 3) {
      const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.slice(0, 2), 16);
      const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.slice(2, 4), 16);
      const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.slice(4, 6), 16);
      return [r, g, b];
    }
  }

  return null;
}

function resolveColorExpression(value: string, vars: Map<string, string>): string | null {
  let v = value.trim();
  let suffix = '';
  if (v.endsWith('!important')) {
    suffix = ' !important';
    v = v.slice(0, -10).trim();
  }
  if (v.startsWith('var(')) {
    const match = v.match(/^var\(--([a-z0-9_-]+)\)$/i);
    if (match) {
      const resolved = resolveCssVar(match[1], vars);
      if (!resolved) return null;
      const nested = resolveColorExpression(resolved, vars);
      return nested ? nested + suffix : null;
    }
  }
  const components = extractColorComponents(v);
  if (components) {
    const [r, g, b, a] = components;
    const color = typeof a === 'number' ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
    return color + suffix;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v + suffix;
  return null;
}

function convertCustomProperty(key: string, value: string, vars: Map<string, string>): string[] {
  const result: string[] = [];
  const lowered = key.toLowerCase();
  const colorTargets: Record<string, string[]> = {
    '--bg': ['background-color'],
    '--bgp': ['background-color'],
    '--bgh': ['background-color'],
    '--bg-overlay-color': ['background-color'],
    '--bgh-overlay-color': ['background-color'],
    '--txt': ['color'],
    '--txtp': ['color'],
    '--txth': ['color'],
    '--brd': ['border-color'],
    '--brdh': ['border-color'],
  };

  if (colorTargets[lowered]) {
    const resolved = resolveColorExpression(value, vars);
    if (resolved) {
      for (const property of colorTargets[lowered]) {
        result.push(`${property}: ${resolved}`);
      }
    }
    return result;
  }

  if (lowered === '--shd' || lowered === '--boxshadowtoggleon-shd') {
    const cleaned = value.replace(/!important/g, '').trim();
    if (cleaned) result.push(`box-shadow: ${cleaned}`);
    return result;
  }

  if (lowered === '--rd') {
    const cleaned = value.replace(/!important/g, '').trim();
    if (cleaned) result.push(`border-radius: ${cleaned}`);
    return result;
  }

  return result;
}

function sanitizeCustomPropertyValue(value: string): string {
  let v = value.trim();
  const important = v.endsWith('!important');
  if (important) {
    v = v.slice(0, -10).trim();
  }
  // Leave complex values untouched (they may include shorthand or var() expressions).
  v = v.replace(/\s+/g, ' ');
  return important ? `${v} !important` : v;
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
