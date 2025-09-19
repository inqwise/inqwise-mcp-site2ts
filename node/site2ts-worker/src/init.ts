import { emitProgress, run, rpcError } from './utils.js';
import { ulid } from 'ulid';

const INIT_TIMEOUT_MS = 120_000;

export async function initRuntime() {
  const jobId = ulid();
  emitProgress({ tool: 'initRuntime', phase: 'start', extra: { jobId } });
  try {
    const res = await run('npx', ['playwright', 'install', 'chromium'], process.cwd(), {
      timeoutMs: INIT_TIMEOUT_MS,
    });
    if (res.timedOut) {
      throw rpcError(
        -32007,
        `init runtime timed out after ${Math.round(INIT_TIMEOUT_MS / 1000)}s while installing Playwright Chromium`,
        { step: 'playwright install', timeoutMs: INIT_TIMEOUT_MS },
      );
    }
    emitProgress({ tool: 'initRuntime', phase: 'complete', extra: { jobId } });
  } catch (err: unknown) {
    if ((err as any)?.code === -32007) {
      emitProgress({ tool: 'initRuntime', phase: 'error', detail: (err as any).message, extra: { jobId } });
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    emitProgress({ tool: 'initRuntime', phase: 'warning', detail: message, extra: { jobId } });
    return { ok: true, jobId, warning: `initRuntime encountered an error: ${message}` };
  }
  return { ok: true, jobId };
}
