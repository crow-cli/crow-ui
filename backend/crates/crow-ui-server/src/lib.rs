//! WebSocket server for Murder IDE.
//!
//! Provides a WebSocket-based IPC layer between the React frontend and
//! Rust backend, replacing Tauri's `invoke()` mechanism.

mod ws;
mod router;
mod state;
mod handlers;
pub mod protocol;
pub mod acp_session;
pub mod relay_state;
pub mod task;

pub use ws::{run_server, terminal_event_bridge};
pub use state::AppState;
