use crate::buffer::{Buffer, EditResult};
use crate::edit::{ChangeEvent, EditOperation};
use crate::encoding::Encoding;
use crate::line_ending::LineEnding;

/// Configurable options for text model behavior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextModelOptions {
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub trim_trailing_whitespace: bool,
    pub insert_final_newline: bool,
    pub trim_final_newlines: bool,
    pub default_line_ending: LineEnding,
}

impl Default for TextModelOptions {
    fn default() -> Self {
        Self {
            tab_size: 4,
            insert_spaces: true,
            trim_trailing_whitespace: false,
            insert_final_newline: true,
            trim_final_newlines: false,
            default_line_ending: LineEnding::os_default(),
        }
    }
}

const LARGE_FILE_THRESHOLD: usize = 5_000_000;

/// High-level document model with metadata.
///
/// Wraps a [`Buffer`] with document metadata (language, URI, version,
/// encoding, dirty state) and save transformations.
#[derive(Debug, Clone)]
pub struct TextModel {
    pub buffer: Buffer,
    pub language_id: String,
    pub uri: String,
    pub version: i32,
    pub encoding: Encoding,
    pub line_ending: LineEnding,
    pub is_dirty: bool,
    pub is_readonly: bool,
    pub is_large_file: bool,
    pub options: TextModelOptions,
}

impl TextModel {
    /// Creates a new text model from raw content.
    pub fn new(content: &str, language_id: &str, uri: &str) -> Self {
        let buffer = Buffer::from_str(content);
        let line_ending = buffer.get_eol();
        Self {
            is_large_file: buffer.len_bytes() > LARGE_FILE_THRESHOLD,
            buffer,
            language_id: language_id.to_string(),
            uri: uri.to_string(),
            version: 1,
            encoding: Encoding::Utf8,
            line_ending,
            is_dirty: false,
            is_readonly: false,
            options: TextModelOptions::default(),
        }
    }

    /// Creates a text model from raw bytes with encoding detection.
    pub fn from_bytes(bytes: &[u8], language_id: &str, uri: &str) -> Self {
        let encoding = crate::encoding::detect_encoding(bytes);
        let content = crate::encoding::decode(bytes, encoding).unwrap_or_default();
        let mut model = Self::new(&content, language_id, uri);
        model.encoding = encoding;
        model
    }

    /// Applies a single edit, marks dirty, increments version.
    pub fn apply_edit(&mut self, edit: &EditOperation) -> ChangeEvent {
        let event = self.buffer.apply_edit(edit);
        self.is_dirty = true;
        self.version += 1;
        event
    }

    /// Applies multiple edits with undo information.
    pub fn apply_edits(&mut self, edits: &[EditOperation]) -> Vec<EditResult> {
        let results = self.buffer.apply_edits_with_undo(edits);
        if !edits.is_empty() {
            self.is_dirty = true;
            self.version += 1;
        }
        results
    }

    pub fn get_full_content(&self) -> String { self.buffer.text() }

    pub fn set_options(&mut self, options: TextModelOptions) { self.options = options; }

    pub fn detect_indentation(&self) -> (bool, u32) {
        let info = self.buffer.detect_indentation();
        (!info.use_tabs, info.tab_size)
    }

    pub fn increment_version(&mut self) -> i32 {
        self.version += 1;
        self.version
    }

    pub fn line_count(&self) -> u32 { self.buffer.get_line_count() }
    pub fn get_line_content(&self, line: u32) -> String { self.buffer.get_line_content(line) }

    pub fn mark_saved(&mut self) -> i32 {
        self.is_dirty = false;
        self.version
    }

    /// Prepares content for saving with save transformations applied.
    pub fn get_save_content(&self) -> String {
        let mut content = self.get_full_content();

        if self.options.trim_trailing_whitespace {
            content = content
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join(self.line_ending.as_str());
            if content.ends_with(self.line_ending.as_str()) || self.options.insert_final_newline {
                content.push_str(self.line_ending.as_str());
            }
        }

        if self.options.trim_final_newlines {
            let eol = self.line_ending.as_str();
            while content.ends_with(&format!("{eol}{eol}")) {
                content.truncate(content.len() - eol.len());
            }
        }

        if self.options.insert_final_newline {
            let eol = self.line_ending.as_str();
            if !content.ends_with(eol) {
                content.push_str(eol);
            }
        }

        content
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Position, Range};

    #[test]
    fn new_model_basic() {
        let model = TextModel::new("hello\nworld", "plaintext", "file:///test.txt");
        assert_eq!(model.language_id, "plaintext");
        assert_eq!(model.version, 1);
        assert!(!model.is_dirty);
        assert!(!model.is_large_file);
        assert_eq!(model.line_count(), 2);
    }

    #[test]
    fn apply_edit_marks_dirty() {
        let mut model = TextModel::new("hello", "rust", "file:///test.rs");
        model.apply_edit(&EditOperation::insert(Position::new(0, 5), " world".into()));
        assert!(model.is_dirty);
        assert_eq!(model.version, 2);
        assert_eq!(model.get_full_content(), "hello world");
    }

    #[test]
    fn detect_indentation_spaces() {
        let model = TextModel::new("fn() {\n    a;\n    b;\n}", "js", "file:///test.js");
        let (insert_spaces, tab_size) = model.detect_indentation();
        assert!(insert_spaces);
        assert_eq!(tab_size, 4);
    }

    #[test]
    fn mark_saved() {
        let mut model = TextModel::new("hello", "txt", "file:///test.txt");
        model.apply_edit(&EditOperation::insert(Position::new(0, 5), "!".into()));
        assert!(model.is_dirty);
        model.mark_saved();
        assert!(!model.is_dirty);
    }

    #[test]
    fn get_save_content_inserts_final_newline() {
        let mut model = TextModel::new("hello", "txt", "file:///test.txt");
        model.options.insert_final_newline = true;
        let content = model.get_save_content();
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn get_save_content_trims_whitespace() {
        let mut model = TextModel::new("hello   \nworld  \n", "txt", "file:///test.txt");
        model.options.trim_trailing_whitespace = true;
        model.options.insert_final_newline = true;
        let content = model.get_save_content();
        assert!(content.starts_with("hello\nworld\n"));
    }

    #[test]
    fn apply_edits_with_undo() {
        let mut model = TextModel::new("hello world", "rust", "file:///test.rs");
        let results = model.apply_edits(&[EditOperation::replace(
            Range::new(Position::new(0, 6), Position::new(0, 11)), "rust".into(),
        )]);
        assert_eq!(model.get_full_content(), "hello rust");
        model.buffer.apply_edit(&results[0].inverse_edit);
        assert_eq!(model.get_full_content(), "hello world");
    }
}
