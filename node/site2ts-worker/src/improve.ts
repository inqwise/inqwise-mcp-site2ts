import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { ensureDir } from './utils.js';

export type ImproveRequest = {
  generationId: string;
  route?: string;
  issues?: string[];
  instructions?: string;
  metadata?: Record<string, unknown>;
};

export type ImproveResult = {
  jobId: string;
  planPath: string;
  acknowledged: boolean;
};

export async function improve(req: ImproveRequest): Promise<ImproveResult> {
  if (!req.generationId) {
    throw Object.assign(new Error('generationId required'), { code: -32602 });
  }

  const jobId = ulid();
  const outDir = path.join('.site2ts', 'reports', 'improve');
  await ensureDir(outDir);

  const payload = {
    jobId,
    requestedAt: new Date().toISOString(),
    generationId: req.generationId,
    route: req.route ?? null,
    issues: req.issues ?? [],
    instructions: req.instructions ?? null,
    metadata: req.metadata ?? {},
  };

  const planPath = path.join(outDir, `${jobId}.json`);
  await fs.writeFile(planPath, JSON.stringify(payload, null, 2));

  return { jobId, planPath, acknowledged: true };
}
