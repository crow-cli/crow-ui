//! Workspace management — file tree, watcher, search, path utilities for `Murder`.

pub mod error;
pub mod file_ops;
pub mod file_tree;
pub mod path_util;
pub mod watcher;
pub mod fuzzy_file_finder;
pub mod search;
pub mod workspace;
pub mod worktree_state;

pub use error::{WorkspaceError, WorkspaceResult};
pub use file_ops::{DirEntry, FileStat};
pub use file_tree::{FileNode, FileTree, FileSortOrder};
pub use path_util::PathInfo;
pub use watcher::{FileEvent, FileEventKind, FileWatcher};
pub use fuzzy_file_finder::{FileIndex, FileMatch as FuzzyFileMatch};
pub use search::{
    SearchOptions, SearchQuery, SearchResult, SearchMatchWithContext,
    CancellationToken, SearchEngine,
};
pub use workspace::Workspace;
pub use worktree_state::{WorktreeState, FileChange};
