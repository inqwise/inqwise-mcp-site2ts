import { run } from './utils';
import { ulid } from 'ulid';

export async function initRuntime() {
  const jobId = ulid();
  // Attempt to ensure Chromium browser is installed for Playwright
  try {
    await run('npx', ['playwright', 'install', 'chromium'], process.cwd());
  } catch {
    // ignore install failures; runtime may already have a system browser
  }
  return { ok: true, jobId };
}

