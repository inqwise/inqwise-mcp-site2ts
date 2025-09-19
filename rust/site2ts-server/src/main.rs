use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use tracing::{error, info, Level};
use tracing_subscriber::EnvFilter;
use ulid::Ulid;
mod worker;
use worker::Worker;

type RpcResult<T> = std::result::Result<T, RpcError>;

#[derive(Debug, Clone)]
pub(crate) struct RpcError {
    code: i32,
    message: String,
    data: Option<Value>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl RpcError {
    fn new(code: i32, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code,
            message: message.into(),
            data,
        }
    }

    fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(-32602, message.into(), None)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(-32603, message.into(), None)
    }

    fn code(&self) -> i32 {
        self.code
    }

    fn message(&self) -> &str {
        &self.message
    }

    fn to_json(&self) -> Value {
        let mut obj = json!({
            "code": self.code,
            "message": self.message,
        });
        if let Some(data) = &self.data {
            obj["data"] = data.clone();
        }
        obj
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for RpcError {}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[serde(default)]
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    id: Option<Value>,
}

#[derive(Debug, Serialize)]
struct RpcResponse<'a> {
    jsonrpc: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct InitParams {
    #[serde(rename = "projectRoot")]
    project_root: String,
}

#[derive(Debug, Serialize)]
struct Pinned {
    node: String,
    next: String,
    ts: String,
    playwright: String,
}

#[derive(Debug, Deserialize)]
struct CrawlParams {
    #[serde(rename = "startUrl")]
    start_url: String,
    #[serde(default = "default_true", rename = "sameOrigin")] // sameOrigin default true
    same_origin: bool,
    #[serde(default = "default_max_pages", rename = "maxPages")] // 50
    max_pages: u32,
    #[serde(default = "default_max_depth", rename = "maxDepth")] // 5
    max_depth: u32,
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
    #[serde(default = "default_concurrency")]
    concurrency: u32,
    #[serde(default, rename = "delayMs")]
    delay_ms: u64,
    #[serde(default = "default_true", rename = "useSitemap")] // true
    use_sitemap: bool,
    #[serde(default = "default_true", rename = "obeyRobots")] // true
    obey_robots: bool,
}

#[derive(Debug, Deserialize)]
struct AnalyzeParams {
    #[serde(rename = "siteMapId")]
    site_map_id: String,
}

#[derive(Debug, Deserialize)]
struct ScaffoldParams {
    #[serde(rename = "analysisId")]
    analysis_id: String,
    #[serde(default = "default_true", rename = "appRouter")] // default true
    app_router: bool,
}

#[derive(Debug, Deserialize)]
struct GenerateParams {
    #[serde(rename = "analysisId")]
    analysis_id: String,
    #[serde(rename = "scaffoldId")]
    scaffold_id: String,
    #[serde(default, rename = "tailwindMode")]
    tailwind_mode: String,
}

fn default_true() -> bool {
    true
}
fn default_max_pages() -> u32 {
    50
}
fn default_max_depth() -> u32 {
    5
}
fn default_concurrency() -> u32 {
    4
}

fn ensure_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir_all(path).with_context(|| format!("creating dir {}", path.display()))?;
    }
    Ok(())
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let mut f = fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    let s = serde_json::to_string_pretty(value)?;
    f.write_all(s.as_bytes())?;
    Ok(())
}

fn parse_params<T: DeserializeOwned>(params: &Value) -> std::result::Result<T, RpcError> {
    serde_json::from_value(params.clone()).map_err(|e| RpcError::invalid_params(e.to_string()))
}

fn log_ndjson(job_id: &str, phase: &str, msg: &str, data: Value) -> Result<()> {
    let logs_dir = PathBuf::from(".site2ts").join("logs");
    ensure_dir(&logs_dir)?;
    let path = logs_dir.join(format!("{}.ndjson", job_id));
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("open log {}", path.display()))?;
    let entry = json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": "info",
        "jobId": job_id,
        "phase": phase,
        "msg": msg,
        "data": data
    });
    let line = serde_json::to_string(&entry)?;
    writeln!(f, "{}", line)?;
    Ok(())
}

fn handle_init(params: InitParams) -> RpcResult<Value> {
    // Prepare sandbox directories
    let root = PathBuf::from(&params.project_root);
    let site2ts = root.join(".site2ts");
    for dir in [
        site2ts.join("staging"),
        site2ts.join("cache").join("pw"),
        site2ts.join("reports"),
        site2ts.join("logs"),
        site2ts.join("exports"),
    ] {
        ensure_dir(&dir).map_err(|e| RpcError::internal(e.to_string()))?;
    }

    // Write pins.json per spec (pinned versions; can be refined later)
    let pins = json!({
        "node": "20.15.0",
        "next": "14.2.5",
        "typescript": "5.5.4",
        "playwright": "1.46.0",
        "tailwind": "3.4.10",
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    write_json_pretty(&site2ts.join("pins.json"), &pins)
        .map_err(|e| RpcError::internal(e.to_string()))?;

    let pinned = Pinned {
        node: "20.x".to_string(),
        next: "14.x".to_string(),
        ts: "5.x".to_string(),
        playwright: "1.x".to_string(),
    };
    // Ask worker to ensure runtime deps (Chromium) are available
    if let Ok(mutex) = Worker::get() {
        if let Ok(mut w) = mutex.lock() {
            w.call("initRuntime", json!({}))?;
        }
    }
    serde_json::to_value(json!({ "ok": true, "pinned": pinned }))
        .map_err(|e| RpcError::internal(e.to_string()))
}

fn handle_crawl(params: CrawlParams) -> RpcResult<Value> {
    // Call Node worker crawl for IDs, then persist sitemap manifest according to spec.
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call(
        "crawl",
        json!({
            "startUrl": params.start_url,
            "sameOrigin": params.same_origin,
            "maxPages": params.max_pages,
            "maxDepth": params.max_depth,
            "allow": params.allow,
            "deny": params.deny,
            "concurrency": params.concurrency,
            "delayMs": params.delay_ms,
            "useSitemap": params.use_sitemap,
            "obeyRobots": params.obey_robots
        }),
    )?;

    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let site_map_id = res
        .get("siteMapId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let pages = res.get("pages").cloned().unwrap_or_else(|| json!([]));

    let sitemap_dir = PathBuf::from(".site2ts").join("cache").join("sitemaps");
    ensure_dir(&sitemap_dir).map_err(|e| RpcError::internal(e.to_string()))?;
    let sitemap = json!({
        "siteMapId": site_map_id,
        "startUrl": params.start_url,
        "sameOrigin": params.same_origin,
        "maxPages": params.max_pages,
        "maxDepth": params.max_depth,
        "allow": params.allow,
        "deny": params.deny,
        "useSitemap": params.use_sitemap,
        "obeyRobots": params.obey_robots,
        "pages": pages
    });
    let path = sitemap_dir.join(format!("{}.json", site_map_id));
    write_json_pretty(&path, &sitemap).map_err(|e| RpcError::internal(e.to_string()))?;
    log_ndjson(
        &job_id,
        "crawl",
        "Crawl stub completed",
        json!({ "pages": sitemap["pages"].as_array().map(|a| a.len()).unwrap_or(0) }),
    )
    .map_err(|e| RpcError::internal(e.to_string()))?;

    Ok(json!({
        "jobId": job_id,
        "siteMapId": site_map_id,
        "pages": sitemap["pages"].clone()
    }))
}

fn handle_analyze(params: AnalyzeParams) -> RpcResult<Value> {
    // Delegate to worker and persist analysis.json
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call("analyze", json!({ "siteMapId": params.site_map_id }))?;

    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let analysis_id = res
        .get("analysisId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());

    // Write analysis.json
    let analysis = json!({
        "routes": res.get("routes").cloned().unwrap_or(json!([])),
        "forms": res.get("forms").cloned().unwrap_or(json!([])),
        "assets": res.get("assets").cloned().unwrap_or(json!({"images":[],"fonts":[],"styles":[]})),
    });
    let out = PathBuf::from(".site2ts").join("staging").join("meta");
    ensure_dir(&out).map_err(|e| RpcError::internal(e.to_string()))?;
    write_json_pretty(&out.join("analysis.json"), &analysis)
        .map_err(|e| RpcError::internal(e.to_string()))?;

    log_ndjson(
        &job_id,
        "analyze",
        "Analyze complete",
        json!({
            "routes": analysis["routes"].as_array().map(|a| a.len()).unwrap_or(0)
        }),
    )
    .map_err(|e| RpcError::internal(e.to_string()))?;

    Ok(json!({
        "jobId": job_id,
        "analysisId": analysis_id,
        "routes": analysis["routes"].clone(),
        "assets": analysis["assets"].clone()
    }))
}

fn handle_scaffold(params: ScaffoldParams) -> RpcResult<Value> {
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call(
        "scaffold",
        json!({
            "analysisId": params.analysis_id,
            "appRouter": params.app_router,
        }),
    )?;

    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let scaffold_id = res
        .get("scaffoldId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let out_dir = res
        .get("outDir")
        .and_then(|v| v.as_str())
        .unwrap_or(".site2ts/staging")
        .to_string();

    log_ndjson(
        &job_id,
        "scaffold",
        "Scaffold prepared",
        json!({ "outDir": out_dir }),
    )
    .map_err(|e| RpcError::internal(e.to_string()))?;

    Ok(json!({
        "jobId": job_id,
        "scaffoldId": scaffold_id,
        "outDir": out_dir
    }))
}

fn handle_generate(params: GenerateParams) -> RpcResult<Value> {
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call(
        "generate",
        json!({
            "analysisId": params.analysis_id,
            "scaffoldId": params.scaffold_id,
            "tailwindMode": if params.tailwind_mode.is_empty() { "full" } else { &params.tailwind_mode },
        }),
    )?;

    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let generation_id = res
        .get("generationId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());

    log_ndjson(
        &job_id,
        "generate",
        "Generate complete",
        json!({ "generationId": generation_id }),
    )
    .map_err(|e| RpcError::internal(e.to_string()))?;

    Ok(json!({
        "jobId": job_id,
        "generationId": generation_id
    }))
}

#[derive(Debug, Deserialize)]
struct DiffParams {
    #[serde(rename = "generationId")]
    generation_id: String,
    #[serde(default)]
    baselines: Option<String>,
    #[serde(default)]
    viewport: Option<Value>,
    #[serde(default)]
    threshold: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct AuditParams {
    #[serde(rename = "generationId")]
    generation_id: String,
    #[serde(default, rename = "tsStrict")]
    ts_strict: Option<bool>,
    #[serde(default, rename = "eslintConfig")]
    eslint_config: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApplyParams {
    #[serde(rename = "generationId")]
    generation_id: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default, rename = "dryRun")]
    dry_run: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct AssetsParams {
    #[serde(rename = "siteMapId")]
    site_map_id: Option<String>,
    #[serde(rename = "generationId")]
    generation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PackParams {
    #[serde(rename = "generationId")]
    generation_id: String,
}

fn handle_diff(params: DiffParams) -> RpcResult<Value> {
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call(
        "diff",
        json!({
            "generationId": params.generation_id,
            "baselines": params.baselines.unwrap_or_else(|| "recrawl".into()),
            "viewport": params.viewport.unwrap_or_else(|| json!({"w":1280,"h":800,"deviceScale":1})),
            "threshold": params.threshold.unwrap_or(0.01),
        }),
    )?;

    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let diff_id = res
        .get("diffId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());

    log_ndjson(
        &job_id,
        "diff",
        "Visual diff complete",
        json!({ "diffId": diff_id }),
    )
    .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(res)
}

fn handle_audit(params: AuditParams) -> RpcResult<Value> {
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call(
        "audit",
        json!({
            "generationId": params.generation_id,
            "tsStrict": params.ts_strict.unwrap_or(true),
            "eslintConfig": params.eslint_config.unwrap_or_else(|| "recommended".into()),
        }),
    )?;

    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    let audit_id = res
        .get("auditId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    log_ndjson(
        &job_id,
        "audit",
        "Audit completed",
        json!({ "auditId": audit_id }),
    )
    .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(res)
}

fn handle_apply(params: ApplyParams) -> RpcResult<Value> {
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call(
        "apply",
        json!({
            "generationId": params.generation_id,
            "target": params.target.unwrap_or_else(|| "./".into()),
            "dryRun": params.dry_run.unwrap_or(false),
        }),
    )?;
    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    log_ndjson(&job_id, "apply", "Apply executed", json!({}))
        .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(res)
}

fn handle_assets(params: AssetsParams) -> RpcResult<Value> {
    let id = params
        .site_map_id
        .or(params.generation_id)
        .unwrap_or_else(|| Ulid::new().to_string());
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call("assets", json!({ "generationId": id }))?;
    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    log_ndjson(&job_id, "assets", "Assets manifest generated", json!({}))
        .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(res)
}

fn handle_pack(params: PackParams) -> RpcResult<Value> {
    let worker_mutex = Worker::get().map_err(|e| RpcError::internal(e.to_string()))?;
    let mut w = worker_mutex
        .lock()
        .map_err(|_| RpcError::internal("failed to lock worker mutex"))?;
    let res = w.call("pack", json!({ "generationId": params.generation_id }))?;
    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    log_ndjson(&job_id, "pack", "Pack completed", json!({}))
        .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(res)
}

fn respond(result: Option<Value>, error: Option<Value>, id: Option<Value>) {
    let resp = RpcResponse {
        jsonrpc: "2.0",
        result,
        error,
        id,
    };
    let s = serde_json::to_string(&resp).unwrap_or_else(|e| {
        serde_json::to_string(&RpcResponse {
            jsonrpc: "2.0",
            result: None,
            error: Some(json!({"code": -32603, "message": format!("internal: {}", e)})),
            id: None,
        })
        .unwrap()
    });
    println!("{}", s);
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive(Level::INFO.into()))
        .with_writer(std::io::stderr)
        .init();
    info!(target = "site2ts", "site2ts-server JSON-RPC starting");

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                error!(?e, "stdin read error");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: RpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                respond(
                    None,
                    Some(json!({"code": -32700, "message": format!("parse error: {}", e)})),
                    None,
                );
                continue;
            }
        };
        let id = req.id.clone();
        let res: Result<Value> = match req.method.as_str() {
            "init" => match parse_params::<InitParams>(&req.params) {
                Ok(params) => handle_init(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "crawl" => match parse_params::<CrawlParams>(&req.params) {
                Ok(params) => handle_crawl(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "analyze" => match parse_params::<AnalyzeParams>(&req.params) {
                Ok(params) => handle_analyze(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "scaffold" => match parse_params::<ScaffoldParams>(&req.params) {
                Ok(params) => handle_scaffold(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "generate" => match parse_params::<GenerateParams>(&req.params) {
                Ok(params) => handle_generate(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "diff" => match parse_params::<DiffParams>(&req.params) {
                Ok(params) => handle_diff(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "audit" => match parse_params::<AuditParams>(&req.params) {
                Ok(params) => handle_audit(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "apply" => match parse_params::<ApplyParams>(&req.params) {
                Ok(params) => handle_apply(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "assets" => match parse_params::<AssetsParams>(&req.params) {
                Ok(params) => handle_assets(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            "pack" => match parse_params::<PackParams>(&req.params) {
                Ok(params) => handle_pack(params).map_err(|e| e.into()),
                Err(e) => Err(e.into()),
            },
            _ => Err(RpcError::new(-32601, "method not found", None).into()),
        };
        match res {
            Ok(v) => respond(Some(v), None, id.clone()),
            Err(e) => {
                if let Some(rpc_err) = e.downcast_ref::<RpcError>() {
                    respond(None, Some(rpc_err.to_json()), id.clone());
                } else {
                    respond(
                        None,
                        Some(json!({
                            "code": -32603,
                            "message": format!("internal error: {}", e)
                        })),
                        id.clone(),
                    );
                }
            }
        }
        io::stdout().flush().ok();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use once_cell::sync::Lazy;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Mutex, Once};

    static TEST_MUTEX: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
    static INIT_CWD: Once = Once::new();

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        let lock = TEST_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        INIT_CWD.call_once(|| {
            let manifest = env!("CARGO_MANIFEST_DIR");
            let repo_root = PathBuf::from(manifest).join("../..");
            std::env::set_current_dir(&repo_root).expect("chdir repo root");
        });
        lock
    }

    fn cleanup_site2ts() {
        let _ = fs::remove_dir_all(".site2ts");
    }

    #[test]
    fn missing_param_returns_invalid_params_error() {
        let _guard = guard();
        let err = parse_params::<InitParams>(&json!({})).unwrap_err();
        assert_eq!(err.code(), -32602);
        assert!(err.message().contains("projectRoot") || err.message().contains("missing field"));
    }

    #[test]
    fn analyze_before_crawl_returns_order_error() {
        let _guard = guard();
        cleanup_site2ts();
        let err = handle_analyze(AnalyzeParams {
            site_map_id: "missing".into(),
        })
        .unwrap_err();
        assert_eq!(err.code(), -32001);
        assert!(err.message().contains("crawl"));
    }

    #[test]
    fn generate_before_scaffold_returns_order_error() {
        let _guard = guard();
        cleanup_site2ts();
        let err = handle_generate(GenerateParams {
            analysis_id: "analysis".into(),
            scaffold_id: "scaffold".into(),
            tailwind_mode: String::new(),
        })
        .unwrap_err();
        assert_eq!(err.code(), -32003);
        assert!(err.message().contains("scaffold"));
    }

    #[test]
    fn apply_before_generate_returns_order_error() {
        let _guard = guard();
        cleanup_site2ts();
        let err = handle_apply(ApplyParams {
            generation_id: "gen".into(),
            target: None,
            dry_run: None,
        })
        .unwrap_err();
        assert_eq!(err.code(), -32006);
        assert!(err.message().contains("generate"));
    }
}
