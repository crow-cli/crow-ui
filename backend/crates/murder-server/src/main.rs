use std::sync::Arc;
use tokio::sync::Mutex;

use murder_server::{AppState, run_server, terminal_event_bridge};

fn parse_port() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == "--port" && i + 1 < args.len() {
            if let Ok(port) = args[i + 1].parse::<u16>() {
                return port;
            }
        }
        // Also support --port=3928 style
        if let Some(rest) = args[i].strip_prefix("--port=") {
            if let Ok(port) = rest.parse::<u16>() {
                return port;
            }
        }
    }
    3928
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let port = parse_port();

    // Set up terminal event broadcasting:
    // crossbeam channel (from TerminalManager) → bridge task → tokio broadcast → all clients
    let mut tm = murder_terminal::TerminalManager::new();
    let event_rx = tm.set_event_channel();
    let event_tx = tokio::sync::broadcast::Sender::new(1024);

    // Spawn the bridge task: reads from crossbeam channel, broadcasts JSON to all WebSocket clients
    let bridge_tx = event_tx.clone();
    tokio::spawn(terminal_event_bridge(event_rx, bridge_tx));

    let app = Arc::new(Mutex::new(AppState::with_terminals(tm, event_tx)));
    run_server(app, port).await;
}
