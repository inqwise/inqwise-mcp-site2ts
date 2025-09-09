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

#[derive(Debug, Deserialize)]
struct RpcRequest {
    #[serde(default)]
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
    projectRoot: String,
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
    startUrl: String,
    #[serde(default = "default_true")] // sameOrigin default true
    sameOrigin: bool,
    #[serde(default = "default_max_pages")] // 50
    maxPages: u32,
    #[serde(default = "default_max_depth")] // 5
    maxDepth: u32,
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
    #[serde(default = "default_concurrency")] // 4
    concurrency: u32,
    #[serde(default)]
    delayMs: u64,
    #[serde(default = "default_true")] // true
    useSitemap: bool,
    #[serde(default = "default_true")] // true
    obeyRobots: bool,
}

fn default_true() -> bool { true }
fn default_max_pages() -> u32 { 50 }
fn default_max_depth() -> u32 { 5 }
fn default_concurrency() -> u32 { 4 }

fn ensure_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::create_dir_all(path).with_context(|| format!("creating dir {}", path.display()))?;
    }
    Ok(())
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() { ensure_dir(parent)?; }
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
    let root = PathBuf::from(&params.projectRoot);
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
    // Stub: generate IDs, write empty sitemap manifest, and return no pages.
    let job_id = Ulid::new().to_string();
    let site_map_id = Ulid::new().to_string();

    // Write sitemap file
    let sitemap_dir = PathBuf::from(".site2ts").join("cache").join("sitemaps");
    ensure_dir(&sitemap_dir)?;
    let sitemap = json!({
        "siteMapId": site_map_id,
        "startUrl": params.startUrl,
        "sameOrigin": params.sameOrigin,
        "maxPages": params.maxPages,
        "maxDepth": params.maxDepth,
        "allow": params.allow,
        "deny": params.deny,
        "useSitemap": params.useSitemap,
        "obeyRobots": params.obeyRobots,
        "pages": [] as [Value; 0]
    });
    let path = sitemap_dir.join(format!("{}.json", site_map_id));
    write_json_pretty(&path, &sitemap)?;

    // Log completion
    log_ndjson(&job_id, "crawl", "Crawl stub completed", json!({ "pages": 0 }))?;

    Ok(json!({
        "jobId": job_id,
        "siteMapId": site_map_id,
        "pages": [] as [Value; 0]
    }))
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
        let line = match line { Ok(l) => l, Err(e) => { error!(?e, "stdin read error"); break; } };
        if line.trim().is_empty() { continue; }
        let req: RpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                respond(None, Some(json!({"code": -32700, "message": format!("parse error: {}", e)})), None);
                continue;
            }
        };
        let id = req.id.clone();
        let res = match req.method.as_str() {
            "init" => serde_json::from_value::<InitParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(|p| handle_init(p)),
            "crawl" => serde_json::from_value::<CrawlParams>(req.params.clone())
                .map_err(|e| anyhow!(e.to_string()))
                .and_then(|p| handle_crawl(p)),
            _ => Err(anyhow!("method not found")),
        };
        match res {
            Ok(v) => respond(Some(v), None, id),
            Err(e) => respond(None, Some(json!({"code": -32601, "message": e.to_string()})), id),
        }
        io::stdout().flush().ok();
    }

    Ok(())
}
