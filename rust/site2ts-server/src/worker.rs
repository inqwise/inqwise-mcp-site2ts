use anyhow::{anyhow, Context, Result};
use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use ulid::Ulid;

static WORKER: OnceCell<Mutex<Worker>> = OnceCell::new();

pub struct Worker {
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
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no worker stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no worker stdout"))?;
        Ok(Self {
            child,
            stdin,
            stdout: std::io::BufReader::new(stdout),
        })
    }

    pub fn get() -> Result<&'static Mutex<Worker>> {
        WORKER.get_or_try_init(|| Mutex::new(Worker::spawn()?)).map_err(|e| anyhow!(e.to_string()))
    }

    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = Ulid::new().to_string();
        let req = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id
        });
        let line = serde_json::to_string(&req)? + "\n";
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()?;

        let mut buf = String::new();
        self.stdout
            .read_line(&mut buf)
            .context("read worker response line")?;
        if buf.trim().is_empty() {
            return Err(anyhow!("empty response from worker"));
        }
        let v: Value = serde_json::from_str(&buf).context("parse worker JSON")?;
        if let Some(err) = v.get("error") {
            return Err(anyhow!("worker error: {}", err));
        }
        Ok(v.get("result").cloned().unwrap_or(json!({})))
    }
}

