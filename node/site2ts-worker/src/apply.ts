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
    await fs.writeFile(path.join(planDir, `${jobId}.plan.json`), JSON.stringify({ changedFiles, deletedFiles }, null, 2));
  }

  return { jobId, applied: !dryRun, changedFiles, deletedFiles };
}

