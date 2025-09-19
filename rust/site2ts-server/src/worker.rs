use anyhow::{anyhow, Context, Result};
use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use ulid::Ulid;

use crate::RpcError;

static WORKER: OnceCell<Mutex<Worker>> = OnceCell::new();

pub struct Worker {
    // Keep process alive; never read directly
    #[allow(dead_code)]
    child: Child,
    stdin: ChildStdin,
    stdout: std::io::BufReader<ChildStdout>,
}

impl Worker {
    fn spawn() -> Result<Self> {
        let script = PathBuf::from("node")
            .join("site2ts-worker")
            .join("dist")
            .join("index.js");
        let mut cmd = Command::new("node");
        cmd.arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = cmd.spawn().context("spawn node worker")?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("no worker stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no worker stdout"))?;
        Ok(Self {
            child,
            stdin,
            stdout: std::io::BufReader::new(stdout),
        })
    }

    pub fn get() -> Result<&'static Mutex<Worker>> {
        WORKER.get_or_try_init(|| Worker::spawn().map(Mutex::new))
    }

    pub fn call(&mut self, method: &str, params: Value) -> std::result::Result<Value, RpcError> {
        let id = Ulid::new().to_string();
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id
        });
        let line = serde_json::to_string(&req)
            .map_err(|e| RpcError::internal(format!("serialize worker request failed: {}", e)))?
            + "\n";
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|e| RpcError::internal(format!("write worker stdin failed: {}", e)))?;
        self.stdin
            .flush()
            .map_err(|e| RpcError::internal(format!("flush worker stdin failed: {}", e)))?;

        loop {
            let mut buf = String::new();
            self.stdout
                .read_line(&mut buf)
                .map_err(|e| RpcError::internal(format!("read worker response failed: {}", e)))?;
            if buf.trim().is_empty() {
                return Err(RpcError::internal("empty response from worker"));
            }
            let v: Value = serde_json::from_str(&buf)
                .map_err(|e| RpcError::internal(format!("parse worker JSON failed: {}", e)))?;
            if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                if method == "progress" {
                    print!("{}", buf);
                    std::io::stdout().flush().ok();
                    continue;
                }
            }
            if let Some(err) = v.get("error") {
                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-32603) as i32;
                let message = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("worker error")
                    .to_string();
                let data = err.get("data").cloned();
                return Err(RpcError::new(code, message, data));
            }
            return Ok(v.get("result").cloned().unwrap_or(json!({})));
        }
    }
}
