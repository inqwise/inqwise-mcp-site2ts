# API Examples (MVP)

Concrete JSON-RPC request/response examples for each endpoint. Send one JSON object per line to the server stdin; it replies with one JSON object per line.

## init
Request:
{"jsonrpc":"2.0","method":"init","params":{"projectRoot":"."},"id":"1"}

Response (example):
{"jsonrpc":"2.0","result":{"ok":true,"pinned":{"node":"20.x","next":"14.x","ts":"5.x","playwright":"1.x"}},"id":"1"}

## crawl
Request:
{"jsonrpc":"2.0","method":"crawl","params":{"startUrl":"https://example.com","sameOrigin":true,"maxPages":10,"maxDepth":2},"id":"2"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","siteMapId":"01...","pages":[{"url":"https://example.com/","hash":"..."}]},"id":"2"}

## analyze
Request:
{"jsonrpc":"2.0","method":"analyze","params":{"siteMapId":"01..."},"id":"3"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","analysisId":"01...","routes":[{"route":"/","sourceUrl":"https://example.com/","dynamic":false}],"assets":{"images":[],"fonts":[],"styles":[]}},"id":"3"}

## scaffold
Request:
{"jsonrpc":"2.0","method":"scaffold","params":{"analysisId":"01...","appRouter":true},"id":"4"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","scaffoldId":"01...","outDir":".site2ts/staging"},"id":"4"}

## generate
Request:
{"jsonrpc":"2.0","method":"generate","params":{"analysisId":"01...","scaffoldId":"01...","tailwindMode":"full"},"id":"5"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","generationId":"01..."},"id":"5"}

## diff
Request:
{"jsonrpc":"2.0","method":"diff","params":{"generationId":"01...","baselines":"recrawl","viewport":{"w":1280,"h":800,"deviceScale":1},"threshold":0.01},"id":"6"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","diffId":"01...","perRoute":[{"route":"/","diffRatio":0.004,"artifacts":{"baseline":".site2ts/reports/diff/01.../root/baseline.png","actual":".site2ts/reports/diff/01.../root/actual.png","diff":".site2ts/reports/diff/01.../root/diff.png"}}],"summary":{"passed":1,"failed":0,"avg":0.004}},"id":"6"}

## audit
Request:
{"jsonrpc":"2.0","method":"audit","params":{"generationId":"01...","tsStrict":true,"eslintConfig":"recommended"},"id":"7"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","auditId":"01...","tsc":{"errors":0,"reportPath":".site2ts/reports/tsc/01....json"},"eslint":{"errors":0,"warnings":2,"reportPath":".site2ts/reports/eslint/01....json"}},"id":"7"}

## apply
Request:
{"jsonrpc":"2.0","method":"apply","params":{"generationId":"01...","target":"./","dryRun":false},"id":"8"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","applied":true,"changedFiles":["app/page.tsx"],"deletedFiles":{"removed":[],"skipped":[]}},"id":"8"}

## assets
Request:
{"jsonrpc":"2.0","method":"assets","params":{"generationId":"01..."},"id":"9"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","manifestPath":".site2ts/reports/assets-manifest.json"},"id":"9"}

## pack
Request:
{"jsonrpc":"2.0","method":"pack","params":{"generationId":"01..."},"id":"10"}

Response (example):
{"jsonrpc":"2.0","result":{"jobId":"01...","tarPath":".site2ts/exports/site2ts-mvp.tgz"},"id":"10"}

