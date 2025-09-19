import tar from 'tar';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { emitProgress } from './utils.js';

export async function pack(_generationId: string) {
  const jobId = ulid();
  const tarPath = path.join('.site2ts', 'exports', 'site2ts-mvp.tgz');
  emitProgress({ tool: 'pack', phase: 'start', extra: { jobId } });
  await fs.mkdir(path.dirname(tarPath), { recursive: true });
  await tar.create(
    { gzip: true, file: tarPath, cwd: '.' },
    ['.site2ts/staging', '.site2ts/reports'],
  );
  emitProgress({ tool: 'pack', phase: 'complete', extra: { jobId, tarPath } });
  return { jobId, tarPath };
}
