use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
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

fn handle_init(params: InitParams) -> Result<Value> {
    // Prepare sandbox directories
    let root = PathBuf::from(&params.project_root);
    let site2ts = root.join(".site2ts");
    ensure_dir(&site2ts.join("staging"))?;
    ensure_dir(&site2ts.join("cache").join("pw"))?;
    ensure_dir(&site2ts.join("reports"))?;
    ensure_dir(&site2ts.join("logs"))?;
    ensure_dir(&site2ts.join("exports"))?;

    // Write pins.json per spec (pinned versions; can be refined later)
    let pins = json!({
        "node": "20.15.0",
        "next": "14.2.5",
        "typescript": "5.5.4",
        "playwright": "1.46.0",
        "tailwind": "3.4.10",
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    write_json_pretty(&site2ts.join("pins.json"), &pins)?;

    let pinned = Pinned {
        node: "20.x".to_string(),
        next: "14.x".to_string(),
        ts: "5.x".to_string(),
        playwright: "1.x".to_string(),
    };
    Ok(serde_json::to_value(json!({
        "ok": true,
        "pinned": pinned
    }))?)
}

fn handle_crawl(params: CrawlParams) -> Result<Value> {
    // Call Node worker crawl for IDs, then persist sitemap manifest according to spec.
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
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
    ensure_dir(&sitemap_dir)?;
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
    write_json_pretty(&path, &sitemap)?;
    log_ndjson(
        &job_id,
        "crawl",
        "Crawl stub completed",
        json!({ "pages": sitemap["pages"].as_array().map(|a| a.len()).unwrap_or(0) }),
    )?;

    Ok(json!({
        "jobId": job_id,
        "siteMapId": site_map_id,
        "pages": sitemap["pages"].clone()
    }))
}

fn handle_analyze(params: AnalyzeParams) -> Result<Value> {
    // Delegate to worker and persist analysis.json
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
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
    ensure_dir(&out)?;
    write_json_pretty(&out.join("analysis.json"), &analysis)?;

    log_ndjson(
        &job_id,
        "analyze",
        "Analyze complete",
        json!({
            "routes": analysis["routes"].as_array().map(|a| a.len()).unwrap_or(0)
        }),
    )?;

    Ok(json!({
        "jobId": job_id,
        "analysisId": analysis_id,
        "routes": analysis["routes"].clone(),
        "assets": analysis["assets"].clone()
    }))
}

fn handle_scaffold(params: ScaffoldParams) -> Result<Value> {
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
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
    )?;

    Ok(json!({
        "jobId": job_id,
        "scaffoldId": scaffold_id,
        "outDir": out_dir
    }))
}

fn handle_generate(params: GenerateParams) -> Result<Value> {
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
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
    )?;

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

fn handle_diff(params: DiffParams) -> Result<Value> {
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
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
    )?;
    Ok(res)
}

fn handle_audit(params: AuditParams) -> Result<Value> {
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
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
    )?;
    Ok(res)
}

fn handle_apply(params: ApplyParams) -> Result<Value> {
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
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
    log_ndjson(&job_id, "apply", "Apply executed", json!({}))?;
    Ok(res)
}

fn handle_assets(params: AssetsParams) -> Result<Value> {
    let id = params
        .site_map_id
        .or(params.generation_id)
        .unwrap_or_else(|| Ulid::new().to_string());
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
    let res = w.call("assets", json!({ "generationId": id }))?;
    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    log_ndjson(&job_id, "assets", "Assets manifest generated", json!({}))?;
    Ok(res)
}

fn handle_pack(params: PackParams) -> Result<Value> {
    let worker_mutex = Worker::get()?;
    let mut w = worker_mutex.lock().unwrap();
    let res = w.call("pack", json!({ "generationId": params.generation_id }))?;
    let job_id = res
        .get("jobId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Ulid::new().to_string());
    log_ndjson(&job_id, "pack", "Pack completed", json!({}))?;
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
        let res = match req.method.as_str() {
            "init" => serde_json::from_value::<InitParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_init),
            "crawl" => serde_json::from_value::<CrawlParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_crawl),
            "analyze" => serde_json::from_value::<AnalyzeParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_analyze),
            "scaffold" => serde_json::from_value::<ScaffoldParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_scaffold),
            "generate" => serde_json::from_value::<GenerateParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_generate),
            "diff" => serde_json::from_value::<DiffParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_diff),
            "audit" => serde_json::from_value::<AuditParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_audit),
            "apply" => serde_json::from_value::<ApplyParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_apply),
            "assets" => serde_json::from_value::<AssetsParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_assets),
            "pack" => serde_json::from_value::<PackParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(handle_pack),
            _ => Err(anyhow!("method not found")),
        };
        match res {
            Ok(v) => respond(Some(v), None, id),
            Err(e) => respond(
                None,
                Some(json!({"code": -32601, "message": e.to_string()})),
                id,
            ),
        }
        io::stdout().flush().ok();
    }

    Ok(())
}
