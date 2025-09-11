import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
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

export async function ensureDeps(staging: string) {
  const nm = path.join(staging, 'node_modules');
  if (await pathExists(nm)) return;
  // prefer npm ci if lock exists
  const lockPath = path.join(staging, 'package-lock.json');
  const hasLock = await pathExists(lockPath);
  if (hasLock) await run('npm', ['ci'], staging);
  else await run('npm', ['install'], staging);
}

