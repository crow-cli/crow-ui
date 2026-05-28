//! Relay state persistence — tracks which sessions are Waiting or Replying.
//!
//! Used by the task endpoint to determine end-turn policy.

use crow_ui_db::Database;

/// Set relay state for a session. Inserts or updates.
pub fn set_state(db: &Database, session_id: &str, state: &str) -> anyhow::Result<()> {
    db.conn().execute(
        "INSERT INTO relay_state (session_id, state, updated_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at",
        [session_id, state],
    )?;
    Ok(())
}

/// Get relay state for a session. Returns None if no state recorded.
pub fn get_state(db: &Database, session_id: &str) -> anyhow::Result<Option<String>> {
    let mut stmt = db.conn().prepare(
        "SELECT state FROM relay_state WHERE session_id = ?1"
    )?;
    let mut rows = stmt.query([session_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

/// Clear relay state for a session.
pub fn clear_state(db: &Database, session_id: &str) -> anyhow::Result<()> {
    db.conn().execute(
        "DELETE FROM relay_state WHERE session_id = ?1",
        [session_id],
    )?;
    Ok(())
}
