import tar from 'tar';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';

export async function pack(_generationId: string) {
  const jobId = ulid();
  const tarPath = path.join('.site2ts', 'exports', 'site2ts-mvp.tgz');
  await fs.mkdir(path.dirname(tarPath), { recursive: true });
  await tar.create(
    { gzip: true, file: tarPath, cwd: '.' },
    ['.site2ts/staging', '.site2ts/reports'],
  );
  return { jobId, tarPath };
}

