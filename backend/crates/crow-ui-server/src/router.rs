//! WebSocket message router — dispatches incoming messages to handlers.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Incoming WebSocket message from the frontend.
#[derive(Debug, Deserialize)]
pub struct WsRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Outgoing response to a request.
#[derive(Debug, Serialize)]
pub struct WsResponse {
    pub id: u64,
    pub result: Value,
}

/// Outgoing error response.
#[derive(Debug, Serialize)]
pub struct WsError {
    pub id: u64,
    pub error: String,
}

/// Server-to-client notification (no request ID).
#[derive(Debug, Serialize)]
pub struct WsNotification {
    pub method: String,
    pub params: Value,
}
