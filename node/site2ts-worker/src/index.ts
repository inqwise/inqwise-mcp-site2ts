/* Placeholder for long-lived JSON-RPC worker. */
export function ready(): string {
  return 'site2ts-worker ready';
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  // Simple readiness output for CI smoke.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, msg: ready() }));
}

