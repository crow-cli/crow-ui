use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

use crate::Position;

/// A position specified with a UTF-16 column offset.
///
/// Used for LSP interop, where column offsets are in UTF-16 code units
/// rather than Unicode scalar values (characters).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Utf16Position {
    /// Zero-based line number.
    pub line: u32,
    /// Zero-based column in UTF-16 code units.
    pub character: u32,
}

/// Converts a UTF-16 column offset on a line to a character (Unicode scalar
/// value) column offset.
///
/// `line_text` is the content of the line (without trailing newline).
#[must_use]
pub fn utf16_col_to_char_col(line_text: &str, utf16_col: usize) -> usize {
    let mut char_col = 0;
    let mut current_utf16 = 0;

    for grapheme in line_text.graphemes(true) {
        if current_utf16 >= utf16_col {
            break;
        }
        let grapheme_utf16_len: usize = grapheme.encode_utf16().count();
        if current_utf16 + grapheme_utf16_len > utf16_col {
            break;
        }
        current_utf16 += grapheme_utf16_len;
        char_col += grapheme.chars().count();
    }

    char_col
}

/// Converts a character column offset to a UTF-16 column offset.
///
/// `line_text` is the content of the line (without trailing newline).
#[must_use]
pub fn char_col_to_utf16_col(line_text: &str, char_col: usize) -> usize {
    let mut utf16_col = 0;
    let mut current_char = 0;

    for grapheme in line_text.graphemes(true) {
        if current_char >= char_col {
            break;
        }
        utf16_col += grapheme.encode_utf16().count();
        current_char += grapheme.chars().count();
    }

    utf16_col
}

/// Converts an LSP [`Utf16Position`] to a buffer [`Position`].
///
/// `line_text` is the content of the line (without trailing newline).
#[must_use]
pub fn lsp_position_to_position(line_text: &str, lsp_pos: Utf16Position) -> Position {
    let char_col = utf16_col_to_char_col(line_text, lsp_pos.character as usize);
    #[allow(clippy::cast_possible_truncation)]
    Position::new(lsp_pos.line, char_col as u32)
}

/// Converts a buffer [`Position`] to an LSP [`Utf16Position`].
///
/// `line_text` is the content of the line (without trailing newline).
#[must_use]
pub fn position_to_lsp_position(line_text: &str, pos: Position) -> Utf16Position {
    let char_col = pos.column as usize;
    let utf16_col = char_col_to_utf16_col(line_text, char_col);
    #[allow(clippy::cast_possible_truncation)]
    Utf16Position {
        line: pos.line,
        character: utf16_col as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_to_char_ascii() {
        assert_eq!(utf16_col_to_char_col("hello", 3), 3);
    }

    #[test]
    fn utf16_to_char_emoji() {
        // 😀 is 2 UTF-16 code units but 1 character
        assert_eq!(utf16_col_to_char_col("a😀b", 0), 0);
        assert_eq!(utf16_col_to_char_col("a😀b", 1), 1);
        assert_eq!(utf16_col_to_char_col("a😀b", 3), 2);
    }

    #[test]
    fn char_to_utf16_ascii() {
        assert_eq!(char_col_to_utf16_col("hello", 3), 3);
    }

    #[test]
    fn char_to_utf16_emoji() {
        assert_eq!(char_col_to_utf16_col("a😀b", 0), 0);
        assert_eq!(char_col_to_utf16_col("a😀b", 1), 1);
        assert_eq!(char_col_to_utf16_col("a😀b", 2), 3);
    }

    #[test]
    fn lsp_position_roundtrip() {
        let line = "a😀b";
        let buf_pos = Position::new(0, 2);
        let lsp_pos = position_to_lsp_position(line, buf_pos);
        assert_eq!(lsp_pos.character, 3);
        let back = lsp_position_to_position(line, lsp_pos);
        assert_eq!(back, buf_pos);
    }

    #[test]
    fn utf16_col_to_char_col_emoji_at_boundary() {
        let line = "x🎉y";
        assert_eq!(utf16_col_to_char_col(line, 0), 0);
        assert_eq!(utf16_col_to_char_col(line, 1), 1);
        assert_eq!(utf16_col_to_char_col(line, 3), 2);
        assert_eq!(utf16_col_to_char_col(line, 4), 3);
    }
}
