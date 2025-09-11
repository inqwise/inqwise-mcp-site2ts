import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function isExcluded(rel: string): boolean {
  return (
    rel.startsWith('.git/') ||
    rel.startsWith('.site2ts/') ||
    rel.startsWith('node_modules/') ||
    rel.startsWith('.env')
  );
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function apply(_generationId: string, target: string, dryRun: boolean) {
  const jobId = ulid();
  const staging = path.join('.site2ts', 'staging');
  const changedFiles: string[] = [];
  const deletedFiles = { removed: [] as string[], skipped: [] as string[] };

  // Expected pages from analysis
  function routeToDir(route: string): string {
    if (route === '/' || route === '') return '';
    return route.replace(/^\//, '');
  }
  const expectedPages = new Set<string>();
  try {
    const analysisPath = path.join(staging, 'meta', 'analysis.json');
    const raw = await fs.readFile(analysisPath, 'utf-8');
    const analysis = JSON.parse(raw) as { routes?: { route: string }[] };
    for (const r of analysis.routes || []) {
      const rel = path.join('app', routeToDir(r.route), 'page.tsx').replaceAll('\\', '/');
      expectedPages.add(rel);
    }
  } catch {
    // if analysis missing, fall back to stagingSet below
  }

  // Build file sets for deletion analysis (under app/ only)
  const stagingSet = new Set<string>();
  for await (const file of walk(staging)) {
    const rel = path.relative(staging, file).replaceAll('\\', '/');
    if (isExcluded(rel)) continue;
    stagingSet.add(rel);
  }
  const targetApp = path.join(target, 'app');
  try {
    for await (const file of walk(targetApp)) {
      const rel = path.relative(target, file).replaceAll('\\', '/');
      if (isExcluded(rel)) continue;
      const isManagedAsset = rel.startsWith('app/(site2ts)/assets/');
      const isPageFile = rel.startsWith('app/') && rel.endsWith('/page.tsx');
      const presentInStaging = stagingSet.has(rel);
      const presentInAnalysis = expectedPages.size > 0 ? expectedPages.has(rel) : true;
      if ((isManagedAsset || isPageFile) && !presentInStaging && !presentInAnalysis) {
        // Candidate for deletion: managed app/ file not in staging
        if (isPageFile) {
          // Safety: only delete page files that include our auto-generated banner
          try {
            const txt = await fs.readFile(file, 'utf-8');
            if (!txt.includes('Auto-generated content (MVP)')) {
              deletedFiles.skipped.push(rel);
              return;
            }
          } catch {
            deletedFiles.skipped.push(rel);
            return;
          }
        }
        if (dryRun) deletedFiles.removed.push(rel);
        else {
          await fs.rm(file, { force: true });
          deletedFiles.removed.push(rel);
        }
      }
    }
  } catch {
    // target app dir may not exist; ignore
  }

  for await (const file of walk(staging)) {
    const rel = path.relative(staging, file).replaceAll('\\', '/');
    if (isExcluded(rel)) continue;
    const dest = path.join(target, rel);
    const destDir = path.dirname(dest);
    if (!dryRun) {
      await ensureDir(destDir);
      await fs.copyFile(file, dest);
    }
    changedFiles.push(rel);
  }

  if (dryRun) {
    const planDir = path.join('.site2ts', 'reports', 'apply');
    await ensureDir(planDir);
    await fs.writeFile(
      path.join(planDir, `${jobId}.plan.json`),
      JSON.stringify({ changedFiles, deletedFiles }, null, 2),
    );
  }

  return { jobId, applied: !dryRun, changedFiles, deletedFiles };
}
