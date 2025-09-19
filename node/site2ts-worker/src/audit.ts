import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { ensureDeps, run, pathExists, rpcError, emitProgress } from './utils.js';

export async function audit(_generationId: string, tsStrict: boolean, eslintConfig: string) {
  const jobId = ulid();
  const auditId = ulid();
  const staging = path.join('.site2ts', 'staging');
  const reportsDir = path.join('.site2ts', 'reports');
  if (!(await pathExists(path.join(staging, 'package.json')))) {
    throw rpcError(-32003, 'scaffold output missing; run scaffold before audit');
  }
  if (!(await pathExists(path.join('.site2ts', 'reports', 'tailwind', 'fallbacks.json')))) {
    throw rpcError(-32005, 'generation artifacts missing; run generate before audit');
  }
  await fs.mkdir(reportsDir, { recursive: true });
  await ensureDeps(staging);
  emitProgress({ tool: 'audit', phase: 'start', extra: { jobId, generationId: _generationId } });

  // TypeScript tsc
  const tscArgs = ['tsc', '--noEmit', '--pretty', 'false', '--incremental', 'false'];
  if (tsStrict) {
    // rely on tsconfig strict true already in scaffold; left here for future use
  }
  emitProgress({ tool: 'audit', phase: 'tsc', detail: 'running', extra: { jobId } });
  const tscRes = await run('npx', tscArgs, staging);
  const tscReportDir = path.join(reportsDir, 'tsc');
  await fs.mkdir(tscReportDir, { recursive: true });
  const tscReportPath = path.join(tscReportDir, `${auditId}.json`);
  const tscErrors = tscRes.code !== 0 ? (tscRes.stdout.match(/error TS\d+/g) || []).length : 0;
  await fs.writeFile(tscReportPath, JSON.stringify({ code: tscRes.code, errors: tscErrors, stdout: tscRes.stdout }, null, 2));
  emitProgress({ tool: 'audit', phase: 'tsc-complete', extra: { jobId, errors: tscErrors } });

  // ESLint
  const eslintArgs = ['eslint', '.', '--format', 'json'];
  if (eslintConfig && eslintConfig !== 'recommended') {
    // placeholder: we already configured in scaffold
  }
  emitProgress({ tool: 'audit', phase: 'eslint', detail: 'running', extra: { jobId } });
  const eslintRes = await run('npx', eslintArgs, staging);
  const eslintReportDir = path.join(reportsDir, 'eslint');
  await fs.mkdir(eslintReportDir, { recursive: true });
  const eslintReportPath = path.join(eslintReportDir, `${auditId}.json`);
  let eslintErrors = 0;
  let eslintWarnings = 0;
  try {
    const payload = JSON.parse(eslintRes.stdout || '[]') as Array<{ errorCount: number; warningCount: number }>;
    for (const f of payload) {
      eslintErrors += f.errorCount || 0;
      eslintWarnings += f.warningCount || 0;
    }
    await fs.writeFile(eslintReportPath, JSON.stringify(payload, null, 2));
  } catch {
    await fs.writeFile(eslintReportPath, JSON.stringify({ stdout: eslintRes.stdout }, null, 2));
  }

  emitProgress({
    tool: 'audit',
    phase: 'complete',
    extra: { jobId, auditId, tscErrors, eslintErrors, eslintWarnings },
  });

  return {
    jobId,
    auditId,
    tsc: { errors: tscErrors, reportPath: tscReportPath },
    eslint: { errors: eslintErrors, warnings: eslintWarnings, reportPath: eslintReportPath },
  };
}
