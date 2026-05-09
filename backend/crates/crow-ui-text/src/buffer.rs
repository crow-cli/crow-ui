use std::borrow::Cow;
use std::sync::Arc;

use ropey::Rope;
use serde::{Deserialize, Serialize};

use crate::edit::{ChangeEvent, EditOperation};
use crate::line_ending::{detect_line_ending, normalize_line_endings, LineEnding};
use crate::utf16::{
    char_col_to_utf16_col, lsp_position_to_position, position_to_lsp_position,
    utf16_col_to_char_col, Utf16Position,
};
use crate::{Position, Range};

/// Result of applying a single edit, including the inverse edit for undo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditResult {
    /// The range in the buffer after the edit was applied.
    pub range: Range,
    /// The text that was inserted.
    pub text: String,
    /// An edit that, when applied, undoes this edit.
    pub inverse_edit: EditOperation,
}

/// An immutable, cheaply-clonable snapshot of a [`Buffer`].
///
/// Backed by `Arc<Rope>` so clones are O(1). Useful for handing to background
/// threads (syntax highlighting, search) without blocking the editor.
#[derive(Debug, Clone)]
pub struct BufferSnapshot {
    rope: Arc<Rope>,
}

impl BufferSnapshot {
    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }
    pub fn len_bytes(&self) -> usize {
        self.rope.len_bytes()
    }
    pub fn len_lines(&self) -> usize {
        self.rope.len_lines()
    }
    pub fn is_empty(&self) -> bool {
        self.rope.len_chars() == 0
    }
    pub fn line(&self, line_idx: usize) -> Cow<'_, str> {
        self.rope.line(line_idx).into()
    }
    pub fn line_content(&self, line_idx: usize) -> String {
        let line: Cow<'_, str> = self.rope.line(line_idx).into();
        line.trim_end_matches(&['\n', '\r'][..]).to_string()
    }
    pub fn text(&self) -> String {
        String::from(self.rope.as_ref())
    }
    pub fn slice(&self, range: std::ops::Range<usize>) -> String {
        Cow::<str>::from(self.rope.slice(range)).into_owned()
    }
    pub fn char_to_line(&self, char_idx: usize) -> usize {
        self.rope.char_to_line(char_idx)
    }
    pub fn line_to_char(&self, line_idx: usize) -> usize {
        self.rope.line_to_char(line_idx)
    }
    pub fn offset_to_position(&self, char_offset: usize) -> Position {
        let line = self.rope.char_to_line(char_offset);
        let line_start = self.rope.line_to_char(line);
        Position::new(line as u32, (char_offset - line_start) as u32)
    }
    pub fn position_to_offset(&self, pos: Position) -> usize {
        let line_start = self.rope.line_to_char(pos.line as usize);
        line_start + pos.column as usize
    }
}

/// A rope-backed text buffer with efficient editing of large documents.
#[derive(Debug, Clone)]
pub struct Buffer {
    rope: Rope,
    eol: LineEnding,
}

impl Buffer {
    /// Creates a new, empty buffer.
    #[must_use]
    pub fn new() -> Self {
        Self {
            rope: Rope::new(),
            eol: LineEnding::Lf,
        }
    }

    /// Creates a buffer from a string.
    #[must_use]
    pub fn from_str(s: &str) -> Self {
        let eol = detect_line_ending(s);
        Self {
            rope: Rope::from_str(s),
            eol,
        }
    }

    pub fn len_chars(&self) -> usize {
        self.rope.len_chars()
    }
    pub fn len_bytes(&self) -> usize {
        self.rope.len_bytes()
    }
    pub fn len_lines(&self) -> usize {
        self.rope.len_lines()
    }
    pub fn is_empty(&self) -> bool {
        self.rope.len_chars() == 0
    }

    pub fn line(&self, line_idx: usize) -> Cow<'_, str> {
        self.rope.line(line_idx).into()
    }

    pub fn line_content(&self, line_idx: usize) -> String {
        let line: Cow<'_, str> = self.rope.line(line_idx).into();
        line.trim_end_matches(&['\n', '\r'][..]).to_string()
    }

    pub fn line_content_len(&self, line_idx: usize) -> usize {
        self.line_content(line_idx).chars().count()
    }

    pub fn char_to_line(&self, char_idx: usize) -> usize {
        self.rope.char_to_line(char_idx)
    }
    pub fn line_to_char(&self, line_idx: usize) -> usize {
        self.rope.line_to_char(line_idx)
    }
    pub fn char_to_byte(&self, char_idx: usize) -> usize {
        self.rope.char_to_byte(char_idx)
    }

    pub fn slice(&self, range: std::ops::Range<usize>) -> String {
        Cow::<str>::from(self.rope.slice(range)).into_owned()
    }

    pub fn text(&self) -> String {
        String::from(&self.rope)
    }

    pub fn insert(&mut self, char_idx: usize, text: &str) {
        self.rope.insert(char_idx, text);
    }

    pub fn remove(&mut self, range: std::ops::Range<usize>) {
        self.rope.remove(range);
    }

    pub fn replace(&mut self, range: std::ops::Range<usize>, text: &str) {
        self.rope.remove(range.clone());
        self.rope.insert(range.start, text);
    }

    pub fn line_len_chars(&self, line_idx: usize) -> usize {
        self.rope.line(line_idx).len_chars()
    }

    // ── Position/offset conversion ───────────────────────────────────

    pub fn offset_to_position(&self, char_offset: usize) -> Position {
        let line = self.rope.char_to_line(char_offset);
        let line_start = self.rope.line_to_char(line);
        Position::new(line as u32, (char_offset - line_start) as u32)
    }

    pub fn position_to_offset(&self, pos: Position) -> usize {
        let line_start = self.rope.line_to_char(pos.line as usize);
        line_start + pos.column as usize
    }

    // ── Edit operations ──────────────────────────────────────────────

    pub fn apply_edit(&mut self, edit: &EditOperation) -> ChangeEvent {
        let start_offset = self.position_to_offset(edit.range.start);
        let end_offset = self.position_to_offset(edit.range.end);
        let range_length = end_offset - start_offset;
        if start_offset != end_offset {
            self.rope.remove(start_offset..end_offset);
        }
        if !edit.text.is_empty() {
            self.rope.insert(start_offset, &edit.text);
        }
        ChangeEvent {
            range: edit.range.clone(),
            text: edit.text.clone(),
            range_length,
        }
    }

    pub fn apply_edits(&mut self, edits: &[EditOperation]) -> Vec<ChangeEvent> {
        let mut sorted: Vec<&EditOperation> = edits.iter().collect();
        sorted.sort_by_key(|e| std::cmp::Reverse(e.range.start));
        sorted.iter().map(|edit| self.apply_edit(edit)).collect()
    }

    // ── UTF-16 support ───────────────────────────────────────────────

    pub fn utf16_offset_to_char(&self, line: usize, utf16_col: usize) -> usize {
        let line_text: Cow<'_, str> = self.rope.line(line).into();
        let char_col = utf16_col_to_char_col(&line_text, utf16_col);
        self.rope.line_to_char(line) + char_col
    }

    pub fn char_to_utf16_offset(&self, line: usize, char_col: usize) -> usize {
        let line_text: Cow<'_, str> = self.rope.line(line).into();
        char_col_to_utf16_col(&line_text, char_col)
    }

    pub fn lsp_position_to_position(&self, lsp_pos: Utf16Position) -> Position {
        let line_text: Cow<'_, str> = self.rope.line(lsp_pos.line as usize).into();
        lsp_position_to_position(&line_text, lsp_pos)
    }

    pub fn position_to_lsp_position(&self, pos: Position) -> Utf16Position {
        let line_text: Cow<'_, str> = self.rope.line(pos.line as usize).into();
        position_to_lsp_position(&line_text, pos)
    }

    // ── Indentation ──────────────────────────────────────────────────

    pub fn indent_level(&self, line_idx: usize) -> u32 {
        let info = self.detect_indentation();
        let prefix = self.indent_string(line_idx);
        if info.use_tabs {
            prefix.chars().filter(|&c| c == '\t').count() as u32
        } else {
            prefix.chars().filter(|&c| c == ' ').count() as u32
                / info.tab_size
        }
    }

    pub fn indent_string(&self, line_idx: usize) -> String {
        let content = self.line_content(line_idx);
        content.chars().take_while(|c| c.is_whitespace()).collect()
    }

    /// Detect indentation style from buffer content.
    #[must_use]
    pub fn detect_indentation(&self) -> IndentInfo {
        let max_lines = self.len_lines().min(10_000);
        let mut tab_lines = 0u32;
        let mut space_lines = 0u32;
        let mut space_diffs = [0u32; 9];
        let mut prev_spaces: Option<u32> = None;

        for i in 0..max_lines {
            let content = self.line_content(i);
            match content.chars().next() {
                Some('\t') => {
                    tab_lines += 1;
                    prev_spaces = None;
                }
                Some(' ') => {
                    let n = content.chars().take_while(|&c| c == ' ').count() as u32;
                    if n > 0 && !content.trim().is_empty() {
                        space_lines += 1;
                        if let Some(prev) = prev_spaces {
                            let diff = n.abs_diff(prev);
                            if (1..=8).contains(&diff) {
                                space_diffs[diff as usize] += 1;
                            }
                        }
                        prev_spaces = Some(n);
                    }
                }
                _ => {
                    prev_spaces = None;
                }
            }
        }

        if tab_lines > space_lines {
            return IndentInfo {
                use_tabs: true,
                tab_size: 4,
            };
        }

        // If no diffs were detected (all same indentation), default to 4
        let total_diffs: u32 = space_diffs.iter().skip(1).sum();
        let best = if total_diffs == 0 {
            4
        } else {
            space_diffs
                .iter()
                .enumerate()
                .skip(1)
                .max_by_key(|(_, &count)| count)
                .map_or(4, |(size, _)| size as u32)
        };

        IndentInfo {
            use_tabs: false,
            tab_size: if best == 0 { 4 } else { best },
        }
    }

    // ── Line queries ─────────────────────────────────────────────────

    pub fn line_is_empty(&self, line_idx: usize) -> bool {
        self.line_content(line_idx).trim().is_empty()
    }

    pub fn line_is_comment(&self, line_idx: usize, comment_prefix: &str) -> bool {
        self.line_content(line_idx)
            .trim_start()
            .starts_with(comment_prefix)
    }

    // ── Bracket matching ─────────────────────────────────────────────

    pub fn find_matching_bracket(
        &self,
        pos: Position,
        brackets: &[(char, char)],
    ) -> Option<Position> {
        let offset = self.position_to_offset(pos);
        if offset >= self.len_chars() {
            return None;
        }
        let ch = self.slice(offset..offset + 1).chars().next()?;
        for &(open, close) in brackets {
            if ch == open {
                return self.find_bracket_forward(offset, open, close);
            }
            if ch == close {
                return self.find_bracket_backward(offset, open, close);
            }
        }
        None
    }

    fn find_bracket_forward(&self, start: usize, open: char, close: char) -> Option<Position> {
        let text = self.text();
        let mut depth: i32 = 0;
        for (i, c) in text.char_indices() {
            if i < start {
                continue;
            }
            if c == open {
                depth += 1;
            } else if c == close {
                depth -= 1;
                if depth == 0 {
                    return Some(self.offset_to_position(i));
                }
            }
        }
        None
    }

    fn find_bracket_backward(&self, start: usize, open: char, close: char) -> Option<Position> {
        let text = self.text();
        let chars: Vec<char> = text.chars().collect();
        let mut depth: i32 = 0;
        for i in (0..=start).rev() {
            let c = chars[i];
            if c == close {
                depth += 1;
            } else if c == open {
                depth -= 1;
                if depth == 0 {
                    return Some(self.offset_to_position(i));
                }
            }
        }
        None
    }

    pub fn auto_close_pair(&self, pos: Position, _open: char, close: char) -> bool {
        let offset = self.position_to_offset(pos);
        if offset >= self.len_chars() {
            return true;
        }
        let next_char = self.slice(offset..offset + 1).chars().next();
        match next_char {
            None => true,
            Some(c) => c.is_whitespace() || c == close || c == ')' || c == ']' || c == '}',
        }
    }

    pub fn surrounding_pairs(&self, pos: Position) -> Option<(Position, Position)> {
        let pairs = [('(', ')'), ('[', ']'), ('{', '}')];
        let offset = self.position_to_offset(pos);
        let text = self.text();
        let chars: Vec<char> = text.chars().collect();
        let mut best: Option<(usize, usize)> = None;

        for &(open, close) in &pairs {
            let mut depth: i32 = 0;
            let mut open_idx = None;
            for i in (0..offset).rev() {
                if chars[i] == close {
                    depth += 1;
                } else if chars[i] == open {
                    if depth == 0 {
                        open_idx = Some(i);
                        break;
                    }
                    depth -= 1;
                }
            }
            let Some(oi) = open_idx else { continue };
            depth = 0;
            let mut close_idx = None;
            for (i, &ch) in chars.iter().enumerate().skip(offset) {
                if ch == open {
                    depth += 1;
                } else if ch == close {
                    if depth == 0 {
                        close_idx = Some(i);
                        break;
                    }
                    depth -= 1;
                }
            }
            let Some(ci) = close_idx else { continue };
            let span = ci - oi;
            if best.is_none_or(|(_, prev_span)| span < prev_span) {
                best = Some((oi, span));
            }
        }

        best.map(|(oi, span)| {
            (
                self.offset_to_position(oi),
                self.offset_to_position(oi + span),
            )
        })
    }

    // ── Validate position / range ────────────────────────────────────

    pub fn validate_position(&self, pos: Position) -> Position {
        let line_count = self.len_lines();
        if line_count == 0 {
            return Position::ZERO;
        }
        let last_line = line_count - 1;
        let line = (pos.line as usize).min(last_line) as u32;
        let max_col = self.line_content_len(line as usize);
        let column = (pos.column as usize).min(max_col) as u32;
        Position::new(line, column)
    }

    pub fn validate_range(&self, range: Range) -> Range {
        Range::new(
            self.validate_position(range.start),
            self.validate_position(range.end),
        )
    }

    pub fn get_full_model_range(&self) -> Range {
        let line_count = self.len_lines();
        if line_count == 0 || self.is_empty() {
            return Range::new(Position::ZERO, Position::ZERO);
        }
        let last_line = line_count - 1;
        Range::new(
            Position::ZERO,
            Position::new(last_line as u32, self.line_content_len(last_line) as u32),
        )
    }

    // ── Line whitespace queries ─────────────────────────────────────

    pub fn line_first_non_whitespace_column(&self, line_idx: usize) -> u32 {
        let content = self.line_content(line_idx);
        content
            .chars()
            .position(|c| !c.is_whitespace())
            .unwrap_or(content.chars().count()) as u32
    }

    pub fn line_last_non_whitespace_column(&self, line_idx: usize) -> u32 {
        let content = self.line_content(line_idx);
        let chars: Vec<char> = content.chars().collect();
        for i in (0..chars.len()).rev() {
            if !chars[i].is_whitespace() {
                return (i + 1) as u32;
            }
        }
        0
    }

    pub fn modify_position(&self, pos: Position, offset: i64) -> Position {
        let current = self.position_to_offset(self.validate_position(pos));
        let max = self.len_chars();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let candidate = if offset >= 0 {
            current.saturating_add(offset.unsigned_abs() as usize)
        } else {
            current.saturating_sub(offset.unsigned_abs() as usize)
        };
        self.offset_to_position(candidate.min(max))
    }

    // ── Line ending management ──────────────────────────────────────

    pub fn get_eol(&self) -> LineEnding {
        self.eol
    }

    pub fn set_eol(&mut self, eol: LineEnding) {
        if eol == self.eol {
            return;
        }
        self.eol = eol;
        let text = String::from(&self.rope);
        self.rope = Rope::from_str(&normalize_line_endings(&text, eol));
    }

    pub fn get_value_in_range(&self, range: Range, eol: LineEnding) -> String {
        let range = self.validate_range(range);
        let start_offset = self.position_to_offset(range.start);
        let end_offset = self.position_to_offset(range.end);
        if start_offset >= end_offset {
            return String::new();
        }
        normalize_line_endings(&self.slice(start_offset..end_offset), eol)
    }

    pub fn get_value_length_in_range(&self, range: Range) -> usize {
        let range = self.validate_range(range);
        let start_offset = self.position_to_offset(range.start);
        let end_offset = self.position_to_offset(range.end);
        end_offset.saturating_sub(start_offset)
    }

    pub fn get_line_max_column(&self, line: usize) -> u32 {
        if line >= self.len_lines() {
            return 0;
        }
        self.line_content_len(line) as u32
    }

    pub fn get_line_min_column(&self, line: usize) -> u32 {
        if line >= self.len_lines() {
            return 0;
        }
        self.line_first_non_whitespace_column(line)
    }

    pub fn find_bracket_pair(&self, pos: Position) -> Option<(Range, Range)> {
        let (open_pos, close_pos) = self.surrounding_pairs(pos)?;
        let open_range = Range::new(open_pos, Position::new(open_pos.line, open_pos.column + 1));
        let close_range = Range::new(
            close_pos,
            Position::new(close_pos.line, close_pos.column + 1),
        );
        Some((open_range, close_range))
    }

    pub fn get_active_indent_guide(&self, line: usize) -> Option<IndentGuide> {
        if line >= self.len_lines() {
            return None;
        }
        let info = self.detect_indentation();
        let tab_size = if info.tab_size == 0 { 4 } else { info.tab_size };

        let current_indent = if self.line_is_empty(line) {
            let mut above = 0u32;
            if line > 0 {
                for l in (0..line).rev() {
                    if !self.line_is_empty(l) {
                        above = self.indent_level(l);
                        break;
                    }
                }
            }
            let mut below = 0u32;
            for l in (line + 1)..self.len_lines() {
                if !self.line_is_empty(l) {
                    below = self.indent_level(l);
                    break;
                }
            }
            above.max(below)
        } else {
            self.indent_level(line)
        };

        if current_indent == 0 {
            return None;
        }

        let mut start_line = 0;
        for l in (0..line).rev() {
            if !self.line_is_empty(l) && self.indent_level(l) < current_indent {
                start_line = l + 1;
                break;
            }
        }
        let mut end_line = self.len_lines() - 1;
        for l in (line + 1)..self.len_lines() {
            if !self.line_is_empty(l) && self.indent_level(l) < current_indent {
                end_line = l - 1;
                break;
            }
        }

        let column = if info.use_tabs {
            current_indent - 1
        } else {
            (current_indent - 1) * tab_size
        };
        Some(IndentGuide {
            column,
            indent_level: current_indent,
            start_line: start_line as u32,
            end_line: end_line as u32,
        })
    }

    pub fn get_word_at_position(&self, pos: Position) -> Option<WordAtPosition> {
        let pos = self.validate_position(pos);
        let content = self.line_content(pos.line as usize);
        let col = pos.column as usize;
        word_at_column(&content, col)
    }

    pub fn apply_edits_with_undo(&mut self, edits: &[EditOperation]) -> Vec<EditResult> {
        let mut indexed: Vec<(usize, &EditOperation)> = edits.iter().enumerate().collect();
        indexed.sort_by_key(|e| std::cmp::Reverse(e.1.range.start));
        let mut results: Vec<(usize, EditResult)> = Vec::with_capacity(edits.len());

        for (original_idx, edit) in &indexed {
            let start_offset = self.position_to_offset(edit.range.start);
            let end_offset = self.position_to_offset(edit.range.end);
            let old_text = if start_offset < end_offset {
                self.slice(start_offset..end_offset)
            } else {
                String::new()
            };

            let event = self.apply_edit(edit);
            let new_end_offset = start_offset + edit.text.chars().count();
            let new_end_pos = if new_end_offset <= self.len_chars() {
                self.offset_to_position(new_end_offset)
            } else {
                self.offset_to_position(self.len_chars())
            };

            let inverse_edit =
                EditOperation::replace(Range::new(edit.range.start, new_end_pos), old_text);
            results.push((
                *original_idx,
                EditResult {
                    range: Range::new(event.range.start, new_end_pos),
                    text: event.text,
                    inverse_edit,
                },
            ));
        }

        results.sort_by_key(|(idx, _)| *idx);
        results.into_iter().map(|(_, r)| r).collect()
    }

    // ── Convenience line accessors ───────────────────────────────────

    pub fn get_line_content(&self, line: u32) -> String {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return String::new();
        }
        self.line_content(idx)
    }

    pub fn get_line_length(&self, line: u32) -> u32 {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return 0;
        }
        self.line_content_len(idx) as u32
    }

    pub fn get_line_count(&self) -> u32 {
        self.len_lines() as u32
    }

    pub fn get_line_first_non_whitespace(&self, line: u32) -> Option<u32> {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return None;
        }
        self.line_content(idx)
            .chars()
            .position(|c| !c.is_whitespace())
            .map(|p| p as u32)
    }

    pub fn get_line_last_non_whitespace(&self, line: u32) -> Option<u32> {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return None;
        }
        let content = self.line_content(idx);
        let chars: Vec<char> = content.chars().collect();
        for i in (0..chars.len()).rev() {
            if !chars[i].is_whitespace() {
                return Some((i + 1) as u32);
            }
        }
        None
    }

    pub fn find_matching_bracket_default(&self, pos: Position) -> Option<Position> {
        self.find_matching_bracket(pos, &[('(', ')'), ('[', ']'), ('{', '}')])
    }

    pub fn find_enclosing_brackets(&self, pos: Position) -> Option<(Position, Position)> {
        self.surrounding_pairs(pos)
    }

    pub fn get_line_indent(&self, line: u32) -> String {
        let idx = line as usize;
        if idx >= self.len_lines() {
            return String::new();
        }
        self.indent_string(idx)
    }

    pub fn get_line_indent_level(&self, line: u32, tab_size: u32) -> u32 {
        let idx = line as usize;
        if idx >= self.len_lines() || tab_size == 0 {
            return 0;
        }
        let content = self.line_content(idx);
        let mut visual_col: u32 = 0;
        for c in content.chars() {
            match c {
                ' ' => visual_col += 1,
                '\t' => visual_col += tab_size - (visual_col % tab_size),
                _ => break,
            }
        }
        visual_col / tab_size
    }

    pub fn get_text_in_range(&self, range: Range) -> String {
        self.get_value_in_range(range, self.eol)
    }

    pub fn count_occurrences(&self, needle: &str) -> usize {
        if needle.is_empty() {
            return 0;
        }
        self.text().matches(needle).count()
    }

    pub fn snapshot(&self) -> BufferSnapshot {
        BufferSnapshot {
            rope: Arc::new(self.rope.clone()),
        }
    }
}

impl Default for Buffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Information about detected indentation style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndentInfo {
    pub use_tabs: bool,
    pub tab_size: u32,
}

/// Active indent guide for a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IndentGuide {
    pub column: u32,
    pub indent_level: u32,
    pub start_line: u32,
    pub end_line: u32,
}

/// A word at a position in the buffer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WordAtPosition {
    pub word: String,
    pub start_column: u32,
    pub end_column: u32,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn word_at_column(line: &str, col: usize) -> Option<WordAtPosition> {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() || col > chars.len() {
        return None;
    }
    let target = if col >= chars.len() {
        col.saturating_sub(1)
    } else {
        col
    };
    if !is_word_char(chars[target]) {
        return None;
    }
    let mut start = target;
    while start > 0 && is_word_char(chars[start - 1]) {
        start -= 1;
    }
    let mut end = target;
    while end < chars.len() && is_word_char(chars[end]) {
        end += 1;
    }
    let word: String = chars[start..end].iter().collect();
    Some(WordAtPosition {
        word,
        start_column: start as u32,
        end_column: end as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(line: u32, col: u32) -> Position {
        Position::new(line, col)
    }

    #[test]
    fn empty_buffer() {
        let buf = Buffer::new();
        assert!(buf.is_empty());
        assert_eq!(buf.len_chars(), 0);
        assert_eq!(buf.len_lines(), 1);
    }

    #[test]
    fn from_str() {
        let buf = Buffer::from_str("hello");
        assert_eq!(buf.len_chars(), 5);
        assert_eq!(buf.text(), "hello");
    }

    #[test]
    fn from_multiline() {
        let buf = Buffer::from_str("line1\nline2\nline3");
        assert_eq!(buf.len_lines(), 3);
    }

    #[test]
    fn insert_at_beginning() {
        let mut buf = Buffer::from_str("world");
        buf.insert(0, "hello ");
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn delete_range() {
        let mut buf = Buffer::from_str("hello world");
        buf.remove(5..11);
        assert_eq!(buf.text(), "hello");
    }

    #[test]
    fn replace_text() {
        let mut buf = Buffer::from_str("hello world");
        buf.replace(6..11, "rust");
        assert_eq!(buf.text(), "hello rust");
    }

    #[test]
    fn apply_edit_insert() {
        let mut buf = Buffer::from_str("hello world");
        let edit = EditOperation::insert(pos(0, 5), ", beautiful".into());
        buf.apply_edit(&edit);
        assert_eq!(buf.text(), "hello, beautiful world");
    }

    #[test]
    fn apply_edit_delete() {
        let mut buf = Buffer::from_str("hello world");
        let edit = EditOperation::delete(Range::new(pos(0, 5), pos(0, 11)));
        buf.apply_edit(&edit);
        assert_eq!(buf.text(), "hello");
    }

    #[test]
    fn offset_position_roundtrip() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        for offset in 0..buf.len_chars() {
            let p = buf.offset_to_position(offset);
            assert_eq!(buf.position_to_offset(p), offset);
        }
    }

    #[test]
    fn utf16_offset_to_char_emoji() {
        let buf = Buffer::from_str("a😀b\ncd");
        assert_eq!(buf.utf16_offset_to_char(0, 0), 0);
        assert_eq!(buf.utf16_offset_to_char(0, 1), 1);
        assert_eq!(buf.utf16_offset_to_char(0, 3), 2);
    }

    #[test]
    fn lsp_position_roundtrip() {
        let buf = Buffer::from_str("a😀b\ncd");
        let p = pos(0, 2);
        let lsp = buf.position_to_lsp_position(p);
        assert_eq!(lsp.character, 3);
        let back = buf.lsp_position_to_position(lsp);
        assert_eq!(back, p);
    }

    #[test]
    fn snapshot_is_immutable() {
        let mut buf = Buffer::from_str("hello");
        let snap = buf.snapshot();
        buf.insert(5, " world");
        assert_eq!(snap.text(), "hello");
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn validate_position_clamps() {
        let buf = Buffer::from_str("hello\nworld");
        assert_eq!(buf.validate_position(pos(99, 99)), pos(1, 5));
    }

    #[test]
    fn validate_position_empty() {
        let buf = Buffer::new();
        assert_eq!(buf.validate_position(pos(5, 5)), pos(0, 0));
    }

    #[test]
    fn surrounding_pairs_found() {
        let buf = Buffer::from_str("(hello)");
        assert_eq!(
            buf.surrounding_pairs(pos(0, 3)),
            Some((pos(0, 0), pos(0, 6)))
        );
    }

    #[test]
    fn bracket_matching() {
        let buf = Buffer::from_str("(hello)");
        assert_eq!(
            buf.find_matching_bracket_default(pos(0, 0)),
            Some(pos(0, 6))
        );
        assert_eq!(
            buf.find_matching_bracket_default(pos(0, 6)),
            Some(pos(0, 0))
        );
    }

    #[test]
    fn detect_indentation_spaces() {
        let buf = Buffer::from_str("fn() {\n    a;\n    b;\n}");
        let info = buf.detect_indentation();
        assert!(!info.use_tabs);
        assert_eq!(info.tab_size, 4);
    }

    #[test]
    fn detect_indentation_tabs() {
        let buf = Buffer::from_str("fn() {\n\ta;\n\tb;\n}");
        let info = buf.detect_indentation();
        assert!(info.use_tabs);
    }

    #[test]
    fn word_at_position() {
        let buf = Buffer::from_str("hello world");
        let w = buf.get_word_at_position(pos(0, 7)).unwrap();
        assert_eq!(w.word, "world");
    }

    #[test]
    fn apply_edits_with_undo() {
        let mut buf = Buffer::from_str("hello world");
        let edits = vec![EditOperation::replace(
            Range::new(pos(0, 6), pos(0, 11)),
            "rust".into(),
        )];
        let results = buf.apply_edits_with_undo(&edits);
        assert_eq!(buf.text(), "hello rust");
        buf.apply_edit(&results[0].inverse_edit);
        assert_eq!(buf.text(), "hello world");
    }

    #[test]
    fn line_queries() {
        let buf = Buffer::from_str("    hello   ");
        assert_eq!(buf.line_first_non_whitespace_column(0), 4);
        assert_eq!(buf.line_last_non_whitespace_column(0), 9);
    }

    #[test]
    fn get_value_in_range_multiline() {
        let buf = Buffer::from_str("abc\ndef\nghi");
        let r = Range::new(pos(0, 0), pos(2, 3));
        assert_eq!(buf.get_value_in_range(r, LineEnding::Lf), "abc\ndef\nghi");
    }

    #[test]
    fn set_eol_normalizes() {
        let mut buf = Buffer::from_str("hello\nworld\n");
        buf.set_eol(LineEnding::CrLf);
        assert_eq!(buf.get_eol(), LineEnding::CrLf);
        assert!(buf.text().contains("\r\n"));
    }

    #[test]
    fn auto_close_pair() {
        let buf = Buffer::from_str("hello");
        assert!(buf.auto_close_pair(pos(0, 5), '(', ')'));
    }

    #[test]
    fn count_occurrences() {
        let buf = Buffer::from_str("aaa bbb aaa ccc aaa");
        assert_eq!(buf.count_occurrences("aaa"), 3);
    }
}
