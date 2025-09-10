import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function assets(_id: string) {
  const jobId = ulid();
  const manifestDir = path.join('.site2ts', 'reports');
  await ensureDir(manifestDir);

  const stagingAssets = path.join('.site2ts', 'staging', 'app', '(site2ts)', 'assets');
  const items: string[] = [];
  try {
    for (const f of await fs.readdir(stagingAssets)) {
      items.push(path.join('app', '(site2ts)', 'assets', f));
    }
  } catch {
    // ignore
  }

  const manifest = { generated: items };
  const manifestPath = path.join(manifestDir, `assets-manifest.json`);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { jobId, manifestPath };
}

