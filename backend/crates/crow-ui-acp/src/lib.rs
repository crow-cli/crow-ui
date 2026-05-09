//! Agent Client Protocol (ACP) integration for Murder IDE.
//!
//! Spawns agent subprocesses (claude-code, gemini-cli, etc.) and bridges
//! ACP JSON-RPC over stdio to WebSocket for the frontend.

mod agent;
pub mod terminals;

pub use agent::{AgentConfig, AgentManager};
pub use terminals::AcpTerminalManager;
