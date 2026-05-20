use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crow_ui_server::{AppState, run_server, terminal_event_bridge};

fn parse_port() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--port" && i + 1 < args.len() {
            if let Ok(port) = args[i + 1].parse::<u16>() {
                return port;
            }
        }
        if let Some(rest) = args[i].strip_prefix("--port=") {
            if let Ok(port) = rest.parse::<u16>() {
                return port;
            }
        }
    }
    3928
}

fn parse_host() -> String {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--host" && i + 1 < args.len() {
            return args[i + 1].clone();
        }
        if let Some(rest) = args[i].strip_prefix("--host=") {
            return rest.to_string();
        }
    }
    "127.0.0.1".to_string()
}

fn parse_config_dir() -> PathBuf {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--config-dir" && i + 1 < args.len() {
            return PathBuf::from(&args[i + 1]);
        }
        if let Some(rest) = args[i].strip_prefix("--config-dir=") {
            return PathBuf::from(rest);
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".crow"))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[tokio::main]
async fn main() {
    let config_dir = parse_config_dir();
    let log_dir = config_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let file_appender = tracing_appender::rolling::daily(&log_dir, "crow-ui-server");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(non_blocking)
        .init();

    let port = parse_port();
    let host = parse_host();
    eprintln!("[crow-ui-server] config_dir={:?} host={} port={}", config_dir, host, port);

    // Set up terminal event broadcasting:
    // crossbeam channel (from TerminalManager) → bridge task → tokio broadcast → all clients
    let mut tm = crow_ui_terminal::TerminalManager::new();
    let event_rx = tm.set_event_channel();
    let event_tx = tokio::sync::broadcast::Sender::new(1024);

    // Spawn the bridge task: reads from crossbeam channel, broadcasts JSON to all WebSocket clients
    let bridge_tx = event_tx.clone();
    tokio::spawn(terminal_event_bridge(event_rx, bridge_tx));

    let app = Arc::new(Mutex::new(AppState::with_terminals(tm, event_tx, &config_dir)));
    run_server(app, &host, port).await;
}
