//! # murder-text
//!
//! Rope-based text buffer and document model for the Murder ADE.
//!
//! Adapted from sidex-text (MIT licensed): https://github.com/sidenai/sidex
//!
//! Provides:
//! - `Buffer` — rope-backed text buffer with efficient editing of large files
//! - `TextModel` — high-level document wrapper with metadata (version, dirty state, encoding, etc.)
//! - Position/range types, UTF-16 conversion for LSP, line ending management

pub mod buffer;
pub mod edit;
pub mod encoding;
pub mod line_ending;
pub mod position;
pub mod range;
pub mod text_model;
pub mod utf16;

pub use buffer::{Buffer, BufferSnapshot, EditResult};
pub use edit::{ChangeEvent, EditOperation};
pub use encoding::{decode, detect_encoding, encode, Encoding, EncodingError, ALL_ENCODINGS};
pub use line_ending::{
    count_line_endings, detect_line_ending, line_ending_label, normalize_line_endings, LineEnding,
};
pub use position::Position;
pub use range::Range;
pub use text_model::{TextModel, TextModelOptions};
pub use utf16::Utf16Position;
