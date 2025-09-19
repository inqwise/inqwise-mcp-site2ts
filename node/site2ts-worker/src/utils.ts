import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type RunOptions = { timeoutMs?: number };

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  opts: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs).unref();
    }

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, timedOut });
    });
  });
}

export async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function pathExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function rpcError(code: number, message: string, data?: unknown) {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  if (data !== undefined) err.data = data;
  return err;
}

type ProgressParams = {
  tool: string;
  phase: string;
  detail?: string;
  current?: number;
  total?: number;
  extra?: Record<string, unknown>;
};

export function emitProgress(params: ProgressParams) {
  const { tool, phase, detail, current, total, extra } = params;
  const payload: Record<string, unknown> = { tool, phase };
  if (detail) payload.detail = detail;
  if (typeof current === 'number') payload.current = current;
  if (typeof total === 'number') payload.total = total;
  if (extra && Object.keys(extra).length) Object.assign(payload, extra);
  console.log(
    JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: payload }),
  );
}

export async function ensureDeps(staging: string) {
  const nm = path.join(staging, 'node_modules');
  if (await pathExists(nm)) return;
  // prefer npm ci if lock exists
  const lockPath = path.join(staging, 'package-lock.json');
  const hasLock = await pathExists(lockPath);
  const args = hasLock ? ['ci'] : ['install'];
  const res = await run('npm', args, staging, { timeoutMs: 300_000 });
  if (res.timedOut) {
    throw rpcError(
      -32009,
      `dependency install timed out after 300s running "npm ${args[0]}"`,
      { step: `npm ${args[0]}`, timeoutMs: 300_000 },
    );
  }
  if (res.code !== 0) {
    throw rpcError(
      -32009,
      `dependency install failed running "npm ${args[0]}"`,
      { step: `npm ${args[0]}`, exitCode: res.code, stdout: res.stdout, stderr: res.stderr },
    );
  }
}
