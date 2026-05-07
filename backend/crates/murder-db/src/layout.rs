//! Mosaic layout and explorer state persistence per workspace.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};

use crate::db::Database;

// ── Mosaic Layout ──────────────────────────────────────────────────────────────

/// Save the mosaic layout tree (as JSON) for a workspace.
pub fn save_mosaic_layout(db: &Database, workspace_path: &str, layout_json: &str) -> Result<()> {
    db.conn()
        .execute(
            "INSERT INTO mosaic_layout (workspace_path, layout_json, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(workspace_path)
             DO UPDATE SET layout_json = ?2, updated_at = datetime('now')",
            params![workspace_path, layout_json],
        )
        .context("save mosaic layout")?;
    Ok(())
}

/// Load the mosaic layout tree for a workspace. Returns `None` if not found.
pub fn load_mosaic_layout(db: &Database, workspace_path: &str) -> Result<Option<String>> {
    let mut stmt = db
        .conn()
        .prepare("SELECT layout_json FROM mosaic_layout WHERE workspace_path = ?1")
        .context("prepare load layout")?;

    let result = stmt
        .query_row(params![workspace_path], |row| row.get(0))
        .optional()
        .context("query mosaic layout")?;

    Ok(result)
}

/// Delete the mosaic layout for a workspace.
pub fn delete_mosaic_layout(db: &Database, workspace_path: &str) -> Result<()> {
    db.conn()
        .execute(
            "DELETE FROM mosaic_layout WHERE workspace_path = ?1",
            params![workspace_path],
        )
        .context("delete mosaic layout")?;
    Ok(())
}

// ── Explorer State ─────────────────────────────────────────────────────────────

/// Save the explorer state (expanded dirs + active file) for a workspace.
pub fn save_explorer_state(
    db: &Database,
    workspace_path: &str,
    expanded_dirs_json: &str,
    active_file: Option<&str>,
) -> Result<()> {
    db.conn()
        .execute(
            "INSERT INTO explorer_state (workspace_path, expanded_dirs, active_file, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(workspace_path)
             DO UPDATE SET expanded_dirs = ?2, active_file = ?3, updated_at = datetime('now')",
            params![workspace_path, expanded_dirs_json, active_file],
        )
        .context("save explorer state")?;
    Ok(())
}

/// Load explorer state for a workspace. Returns `(expanded_dirs_json, active_file)`.
pub fn load_explorer_state(
    db: &Database,
    workspace_path: &str,
) -> Result<Option<(String, Option<String>)>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT expanded_dirs, active_file FROM explorer_state WHERE workspace_path = ?1",
        )
        .context("prepare load explorer state")?;

    let result = stmt
        .query_row(params![workspace_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .optional()
        .context("query explorer state")?;

    Ok(result)
}

// ── Tile State ─────────────────────────────────────────────────────────────────

/// Save state for a specific tile (open files, active tab, minimized status).
pub fn save_tile_state(
    db: &Database,
    workspace_path: &str,
    tile_id: &str,
    tile_type: &str,
    state_json: &str,
    is_minimized: bool,
) -> Result<()> {
    db.conn()
        .execute(
            "INSERT INTO tile_state (workspace_path, tile_id, tile_type, state_json, is_minimized, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
             ON CONFLICT(workspace_path, tile_id)
             DO UPDATE SET tile_type = ?3, state_json = ?4, is_minimized = ?5, updated_at = datetime('now')",
            params![workspace_path, tile_id, tile_type, state_json, is_minimized as i32],
        )
        .context("save tile state")?;
    Ok(())
}

/// Load all tiles for a workspace. Returns list of `(tile_id, tile_type, state_json, is_minimized)`.
pub fn load_tile_states(
    db: &Database,
    workspace_path: &str,
) -> Result<Vec<(String, String, String, bool)>> {
    let mut stmt = db
        .conn()
        .prepare(
            "SELECT tile_id, tile_type, state_json, is_minimized
             FROM tile_state
             WHERE workspace_path = ?1
             ORDER BY created_at",
        )
        .context("prepare load tile states")?;

    let rows = stmt
        .query_map(params![workspace_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i32>(3)? != 0,
            ))
        })
        .context("query tile states")?;

    let mut tiles = Vec::new();
    for row in rows {
        tiles.push(row.context("read tile state row")?);
    }
    Ok(tiles)
}

/// Delete all tile states for a workspace.
pub fn delete_tile_states(db: &Database, workspace_path: &str) -> Result<()> {
    db.conn()
        .execute(
            "DELETE FROM tile_state WHERE workspace_path = ?1",
            params![workspace_path],
        )
        .context("delete tile states")?;
    Ok(())
}

/// Remove a specific tile from the workspace.
pub fn delete_tile_state(db: &Database, workspace_path: &str, tile_id: &str) -> Result<()> {
    db.conn()
        .execute(
            "DELETE FROM tile_state WHERE workspace_path = ?1 AND tile_id = ?2",
            params![workspace_path, tile_id],
        )
        .context("delete tile state")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let tmp = tempfile::TempDir::new().unwrap();
        Database::open(&tmp.path().join("test.db")).unwrap()
    }

    #[test]
    fn save_and_load_mosaic_layout() {
        let db = test_db();
        let workspace = "/home/test/project";
        let layout = r#"{"first":"editor-1","second":"terminal-1","direction":"row"}"#;
        save_mosaic_layout(&db, workspace, layout).unwrap();
        let loaded = load_mosaic_layout(&db, workspace).unwrap();
        assert_eq!(loaded, Some(layout.to_string()));
    }

    #[test]
    fn load_mosaic_layout_returns_none_for_missing() {
        let db = test_db();
        let loaded = load_mosaic_layout(&db, "/nonexistent").unwrap();
        assert!(loaded.is_none());
    }

    #[test]
    fn save_and_load_explorer_state() {
        let db = test_db();
        let workspace = "/home/test/project";
        save_explorer_state(&db, workspace, r#"["/src","/tests"]"#, Some("/src/main.rs"))
            .unwrap();
        let loaded = load_explorer_state(&db, workspace).unwrap();
        assert_eq!(loaded, Some((r#"["/src","/tests"]"#.to_string(), Some("/src/main.rs".to_string()))));
    }

    #[test]
    fn save_and_load_tile_states() {
        let db = test_db();
        let workspace = "/home/test/project";
        save_tile_state(&db, workspace, "editor-1", "editor", r#"{"files":[{"path":"main.rs","language":"rust"}],"activeIndex":0}"#, false).unwrap();
        save_tile_state(&db, workspace, "term-1", "terminal", r#"{"terminals":["t1"],"activeIndex":0}"#, false).unwrap();
        let tiles = load_tile_states(&db, workspace).unwrap();
        assert_eq!(tiles.len(), 2);
        assert_eq!(tiles[0].0, "editor-1");
        assert_eq!(tiles[0].2, r#"{"files":[{"path":"main.rs","language":"rust"}],"activeIndex":0}"#);
    }
}
