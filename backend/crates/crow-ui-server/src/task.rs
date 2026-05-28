//! Task orchestration — CRUD + end-turn policy loop.
//!
//! POST /api/acp/sessions/:session_id/tasks creates tasks and enters the
//! orchestration loop. The loop controls what the agent is prompted with
//! and handles the four end-turn cases based on relay state.

use std::sync::Arc;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use agent_client_protocol_schema as acp;

use tokio::sync::Mutex;
use crate::acp_session::AcpSession;
use crate::relay_state;
use crate::state::AppState;

// ─── Data types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub title: String,
    pub task: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoCreateRequest {
    pub todo_list: Vec<TodoItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoUpdate {
    pub title: String,
    #[serde(default)]
    pub new_task: Option<String>,
    #[serde(default)]
    pub new_status: Option<String>,
    #[serde(default)]
    pub new_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoUpdateRequest {
    pub todo_updates: Vec<TodoUpdate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoDeleteRequest {
    pub titles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRow {
    pub title: String,
    pub task: String,
    pub status: String,
}

// ─── SQLite CRUD ──────────────────────────────────────────────────────────

/// Create tasks for a session. Returns the created tasks.
pub fn create_tasks(db: &crow_ui_db::Database, session_id: &str, items: &[TodoItem]) -> Result<Vec<TaskRow>> {
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        db.conn().execute(
            "INSERT INTO session_tasks (session_id, title, task, status)
             VALUES (?1, ?2, ?3, 'not_started')",
            [session_id, &item.title, &item.task],
        )?;
        rows.push(TaskRow {
            title: item.title.clone(),
            task: item.task.clone(),
            status: "not_started".to_string(),
        });
    }
    Ok(rows)
}

/// Get all non-complete tasks for a session, in order.
pub fn get_tasks(db: &crow_ui_db::Database, session_id: &str) -> Result<Vec<TaskRow>> {
    let mut stmt = db.conn().prepare(
        "SELECT title, task, status FROM session_tasks
         WHERE session_id = ?1 AND status != 'complete'
         ORDER BY created_at ASC"
    )?;
    let rows = stmt.query_map([session_id], |row| {
        Ok(TaskRow {
            title: row.get(0)?,
            task: row.get(1)?,
            status: row.get(2)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.into())
}

/// Get the first non-complete task for a session.
pub fn get_current_task(db: &crow_ui_db::Database, session_id: &str) -> Result<Option<TaskRow>> {
    let mut stmt = db.conn().prepare(
        "SELECT title, task, status FROM session_tasks
         WHERE session_id = ?1 AND status != 'complete'
         ORDER BY created_at ASC
         LIMIT 1"
    )?;
    let mut rows = stmt.query([session_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(TaskRow {
            title: row.get(0)?,
            task: row.get(1)?,
            status: row.get(2)?,
        }))
    } else {
        Ok(None)
    }
}

/// Update tasks by title. Handles status, task text, and title renames.
pub fn update_tasks(db: &crow_ui_db::Database, session_id: &str, updates: &[TodoUpdate]) -> Result<()> {
    for update in updates {
        // Update status if provided
        if let Some(ref status) = update.new_status {
            db.conn().execute(
                "UPDATE session_tasks SET status = ?1, updated_at = datetime('now')
                 WHERE session_id = ?2 AND title = ?3",
                [status.as_str(), session_id, &update.title],
            )?;
        }

        // Update task text if provided
        if let Some(ref task) = update.new_task {
            db.conn().execute(
                "UPDATE session_tasks SET task = ?1, updated_at = datetime('now')
                 WHERE session_id = ?2 AND title = ?3",
                [task.as_str(), session_id, &update.title],
            )?;
        }

        // Rename title if provided
        if let Some(ref new_title) = update.new_title {
            db.conn().execute(
                "UPDATE session_tasks SET title = ?1, updated_at = datetime('now')
                 WHERE session_id = ?2 AND title = ?3",
                [new_title.as_str(), session_id, &update.title],
            )?;
        }
    }
    Ok(())
}

/// Delete tasks by title.
pub fn delete_tasks(db: &crow_ui_db::Database, session_id: &str, titles: &[String]) -> Result<()> {
    for title in titles {
        db.conn().execute(
            "DELETE FROM session_tasks WHERE session_id = ? AND title = ?",
            [session_id, title],
        )?;
    }
    Ok(())
}

/// Check if a specific task is marked complete.
pub fn is_task_done(db: &crow_ui_db::Database, session_id: &str, title: &str) -> Result<bool> {
    let mut stmt = db.conn().prepare(
        "SELECT status FROM session_tasks WHERE session_id = ? AND title = ?"
    )?;
    let mut rows = stmt.query([session_id, title])?;
    if let Some(row) = rows.next()? {
        let status: String = row.get(0)?;
        Ok(status == "complete")
    } else {
        Ok(false)
    }
}

/// Delete all tasks for a session.
pub fn clear_tasks(db: &crow_ui_db::Database, session_id: &str) -> Result<()> {
    db.conn().execute(
        "DELETE FROM session_tasks WHERE session_id = ?",
        [session_id],
    )?;
    Ok(())
}

// ─── Orchestration loop ───────────────────────────────────────────────────

/// Decision after a prompt turn ends.
enum TaskDecision {
    /// Do nothing — agent is waiting for relay callback.
    Wait,
    /// Reprompt with the given blocks.
    Reprompt(Vec<acp::ContentBlock>),
    /// Cancel and reprompt with next task.
    NextTask(Vec<acp::ContentBlock>),
    /// All tasks done — exit loop.
    Done,
}

impl TaskDecision {
    fn is_wait(&self) -> bool { matches!(self, TaskDecision::Wait) }
    fn is_reprompt(&self) -> bool { matches!(self, TaskDecision::Reprompt(_)) }
    fn is_next_task(&self) -> bool { matches!(self, TaskDecision::NextTask(_)) }
    fn is_done(&self) -> bool { matches!(self, TaskDecision::Done) }

    fn first_block_text(&self) -> Option<String> {
        match self {
            TaskDecision::Reprompt(blocks) | TaskDecision::NextTask(blocks) => {
                blocks.first().and_then(|b| match b {
                    acp::ContentBlock::Text(t) => Some(t.text.clone()),
                    _ => None,
                })
            }
            _ => None,
        }
    }
}

/// Run the task orchestration loop for a session.
/// This takes control of prompting until the agent enters Waiting state
/// or all tasks are complete.
pub async fn run_task_loop(session: Arc<AcpSession>, app: Arc<Mutex<AppState>>) -> Result<()> {
    let session_id = session.session_id.clone();

    loop {
        // Find the current task
        let current = {
            let state = app.lock().await;
            let db = state.db.lock();
            match get_current_task(&db, &session_id)? {
                Some(t) => t,
                None => {
                    let _ = relay_state::clear_state(&db, &session_id);
                    break;
                }
            }
        };

        // Build prompt blocks for the current task
        let prompt_text = format!(
            "## Current Task: {}\n\n{}\n\nWork on this task. Delegate to a sub-agent if needed. Mark the task as complete when done.",
            current.title, current.task
        );
        let blocks = vec![acp::ContentBlock::Text(acp::TextContent::new(prompt_text))];

        // Send prompt and wait for turn to end
        session.prompt(blocks).await?;

        // Turn ended — apply the four-case policy
        let decision = {
            let state = app.lock().await;
            let db = state.db.lock();
            decide_next_action(&db, &session_id, &current.title)?
        };

        match decision {
            TaskDecision::Wait => {
                // Agent delegated — exit loop. Will be re-entered when callback arrives.
                break;
            }
            TaskDecision::Reprompt(next_blocks) => {
                session.prompt(next_blocks).await?;
                continue;
            }
            TaskDecision::NextTask(next_blocks) => {
                let _ = session.cancel().await;
                session.prompt(next_blocks).await?;
                continue;
            }
            TaskDecision::Done => {
                let state = app.lock().await;
                let _ = relay_state::clear_state(&state.db.lock(), &session_id);
                break;
            }
        }
    }

    Ok(())
}

/// Apply the four-case end-turn policy.
fn decide_next_action(
    db: &crow_ui_db::Database,
    session_id: &str,
    current_title: &str,
) -> Result<TaskDecision> {
    let relay = relay_state::get_state(db, session_id)?;
    let task_done = is_task_done(db, session_id, current_title)?;

    match relay.as_deref() {
        // Case B: Waiting — agent delegated to worker, do nothing
        Some("waiting") => Ok(TaskDecision::Wait),

        // Case D: Replying, Done — callback arrived and task is finished
        Some("replying") if task_done => {
            let _ = relay_state::clear_state(db, session_id);

            match get_current_task(db, session_id)? {
                Some(next) => {
                    let text = format!(
                        "## Next Task: {}\n\n{}\n\nPrevious task is complete. Work on this task.",
                        next.title, next.task
                    );
                    Ok(TaskDecision::NextTask(vec![acp::ContentBlock::Text(
                        acp::TextContent::new(text)
                    )]))
                }
                None => Ok(TaskDecision::Done),
            }
        }

        // Case C: Replying, Not Done — callback arrived but task not finished
        Some("replying") => {
            let text = format!(
                "## Current Task: {}\n\n{}\n\nYou received a response from your delegated sub-agent. Review the results and mark this task as complete if done, or delegate again if more work is needed.",
                current_title,
                get_task_description(db, session_id, current_title)?.unwrap_or_default()
            );
            Ok(TaskDecision::Reprompt(vec![acp::ContentBlock::Text(
                acp::TextContent::new(text)
            )]))
        }

        // Case A: NotWaiting — agent never delegated, keep working
        _ => {
            if task_done {
                match get_current_task(db, session_id)? {
                    Some(next) => {
                        let text = format!(
                            "## Next Task: {}\n\n{}\n\nPrevious task is complete. Work on this task.",
                            next.title, next.task
                        );
                        Ok(TaskDecision::NextTask(vec![acp::ContentBlock::Text(
                            acp::TextContent::new(text)
                        )]))
                    }
                    None => Ok(TaskDecision::Done),
                }
            } else {
                let text = format!(
                    "## Current Task: {}\n\n{}\n\nContinue working on this task. Delegate to a sub-agent if needed.",
                    current_title,
                    get_task_description(db, session_id, current_title)?.unwrap_or_default()
                );
                Ok(TaskDecision::Reprompt(vec![acp::ContentBlock::Text(
                    acp::TextContent::new(text)
                )]))
            }
        }
    }
}

fn get_task_description(db: &crow_ui_db::Database, session_id: &str, title: &str) -> Result<Option<String>> {
    let mut stmt = db.conn().prepare(
        "SELECT task FROM session_tasks WHERE session_id = ? AND title = ?"
    )?;
    let mut rows = stmt.query([session_id, title])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crow_ui_db::Database;

    fn test_db() -> Database {
        let tmp = tempfile::TempDir::new().unwrap();
        Database::open(&tmp.path().join("test.db")).unwrap()
    }

    #[test]
    fn create_and_get_tasks() {
        let db = test_db();
        let items = vec![
            TodoItem { title: "Task A".into(), task: "Do A".into() },
            TodoItem { title: "Task B".into(), task: "Do B".into() },
        ];

        let created = create_tasks(&db, "sess-1", &items).unwrap();
        assert_eq!(created.len(), 2);
        assert_eq!(created[0].status, "not_started");

        let tasks = get_tasks(&db, "sess-1").unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "Task A");
        assert_eq!(tasks[1].title, "Task B");
    }

    #[test]
    fn get_current_task_skips_complete() {
        let db = test_db();
        let items = vec![
            TodoItem { title: "Task A".into(), task: "Do A".into() },
            TodoItem { title: "Task B".into(), task: "Do B".into() },
        ];
        create_tasks(&db, "sess-1", &items).unwrap();

        // Mark first task complete
        update_tasks(&db, "sess-1", &[TodoUpdate {
            title: "Task A".into(),
            new_status: Some("complete".into()),
            new_task: None,
            new_title: None,
        }]).unwrap();

        let current = get_current_task(&db, "sess-1").unwrap();
        assert!(current.is_some());
        assert_eq!(current.unwrap().title, "Task B");
    }

    #[test]
    fn update_task_status_and_text() {
        let db = test_db();
        let items = vec![TodoItem { title: "Task A".into(), task: "Do A".into() }];
        create_tasks(&db, "sess-1", &items).unwrap();

        update_tasks(&db, "sess-1", &[TodoUpdate {
            title: "Task A".into(),
            new_status: Some("in_progress".into()),
            new_task: Some("Do A revised".into()),
            new_title: None,
        }]).unwrap();

        let tasks = get_tasks(&db, "sess-1").unwrap();
        assert_eq!(tasks[0].status, "in_progress");
        assert_eq!(tasks[0].task, "Do A revised");
    }

    #[test]
    fn rename_task_title() {
        let db = test_db();
        let items = vec![TodoItem { title: "Old".into(), task: "Do it".into() }];
        create_tasks(&db, "sess-1", &items).unwrap();

        update_tasks(&db, "sess-1", &[TodoUpdate {
            title: "Old".into(),
            new_status: None,
            new_task: None,
            new_title: Some("New".into()),
        }]).unwrap();

        let tasks = get_tasks(&db, "sess-1").unwrap();
        assert_eq!(tasks[0].title, "New");
    }

    #[test]
    fn delete_tasks_by_title() {
        let db = test_db();
        let items = vec![
            TodoItem { title: "A".into(), task: "Do A".into() },
            TodoItem { title: "B".into(), task: "Do B".into() },
        ];
        create_tasks(&db, "sess-1", &items).unwrap();

        super::delete_tasks(&db, "sess-1", &["A".into()]).unwrap();

        let tasks = get_tasks(&db, "sess-1").unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "B");
    }

    #[test]
    fn is_task_done() {
        let db = test_db();
        let items = vec![TodoItem { title: "A".into(), task: "Do A".into() }];
        create_tasks(&db, "sess-1", &items).unwrap();

        assert!(!super::is_task_done(&db, "sess-1", "A").unwrap());

        update_tasks(&db, "sess-1", &[TodoUpdate {
            title: "A".into(),
            new_status: Some("complete".into()),
            new_task: None,
            new_title: None,
        }]).unwrap();

        assert!(super::is_task_done(&db, "sess-1", "A").unwrap());
    }

    #[test]
    fn decide_not_waiting_not_done() {
        let db = test_db();
        let items = vec![TodoItem { title: "A".into(), task: "Do A".into() }];
        create_tasks(&db, "sess-1", &items).unwrap();

        // No relay state, task not done → Case A (reprompt)
        let decision = decide_next_action(&db, "sess-1", "A").unwrap();
        assert!(decision.is_reprompt());
        assert!(decision.first_block_text().unwrap().contains("Continue working"));
    }

    #[test]
    fn decide_waiting() {
        let db = test_db();
        let items = vec![TodoItem { title: "A".into(), task: "Do A".into() }];
        create_tasks(&db, "sess-1", &items).unwrap();
        relay_state::set_state(&db, "sess-1", "waiting").unwrap();

        let decision = decide_next_action(&db, "sess-1", "A").unwrap();
        assert!(decision.is_wait());
    }

    #[test]
    fn decide_replying_done() {
        let db = test_db();
        let items = vec![
            TodoItem { title: "A".into(), task: "Do A".into() },
            TodoItem { title: "B".into(), task: "Do B".into() },
        ];
        create_tasks(&db, "sess-1", &items).unwrap();

        // Mark A complete, set replying state
        update_tasks(&db, "sess-1", &[TodoUpdate {
            title: "A".into(),
            new_status: Some("complete".into()),
            new_task: None,
            new_title: None,
        }]).unwrap();
        relay_state::set_state(&db, "sess-1", "replying").unwrap();

        // Case D: Replying + Done → next task
        let decision = decide_next_action(&db, "sess-1", "A").unwrap();
        assert!(decision.is_next_task());
        assert!(decision.first_block_text().unwrap().contains("Next Task: B"));
    }

    #[test]
    fn decide_replying_not_done() {
        let db = test_db();
        let items = vec![TodoItem { title: "A".into(), task: "Do A".into() }];
        create_tasks(&db, "sess-1", &items).unwrap();
        relay_state::set_state(&db, "sess-1", "replying").unwrap();

        // Case C: Replying + Not Done → reprompt with review msg
        let decision = decide_next_action(&db, "sess-1", "A").unwrap();
        assert!(decision.is_reprompt());
        assert!(decision.first_block_text().unwrap().contains("Review the results"));
    }

    #[test]
    fn decide_not_waiting_done() {
        let db = test_db();
        let items = vec![
            TodoItem { title: "A".into(), task: "Do A".into() },
            TodoItem { title: "B".into(), task: "Do B".into() },
        ];
        create_tasks(&db, "sess-1", &items).unwrap();
        update_tasks(&db, "sess-1", &[TodoUpdate {
            title: "A".into(),
            new_status: Some("complete".into()),
            new_task: None,
            new_title: None,
        }]).unwrap();

        // Case A variant: NotWaiting + Done → next task
        let decision = decide_next_action(&db, "sess-1", "A").unwrap();
        assert!(decision.is_next_task());
        assert!(decision.first_block_text().unwrap().contains("Next Task: B"));
    }

    #[test]
    fn decide_all_done() {
        let db = test_db();
        let items = vec![TodoItem { title: "A".into(), task: "Do A".into() }];
        create_tasks(&db, "sess-1", &items).unwrap();
        update_tasks(&db, "sess-1", &[TodoUpdate {
            title: "A".into(),
            new_status: Some("complete".into()),
            new_task: None,
            new_title: None,
        }]).unwrap();

        let decision = decide_next_action(&db, "sess-1", "A").unwrap();
        assert!(decision.is_done());
    }
}
