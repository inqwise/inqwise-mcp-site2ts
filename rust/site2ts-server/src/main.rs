use anyhow::Result;
use tracing::{info, Level};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive(Level::INFO.into()))
        .init();

    info!(target: "site2ts", "site2ts-server bootstrap complete");
    // Placeholder: JSON-RPC loop will be implemented here.
    println!("{\"ok\":true,\"msg\":\"site2ts-server ready\"}");

    Ok(())
}

