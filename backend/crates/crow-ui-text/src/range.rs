use serde::{Deserialize, Serialize};

use crate::Position;

/// A zero-based range within a text document.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Range {
    /// The start position (inclusive).
    pub start: Position,
    /// The end position (exclusive).
    pub end: Position,
}

impl Range {
    /// Creates a new range from start to end.
    #[must_use]
    pub const fn new(start: Position, end: Position) -> Self {
        Self { start, end }
    }

    /// Returns `true` if this range is empty (start == end).
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.start.line == self.end.line && self.start.column == self.end.column
    }
}

impl std::fmt::Display for Range {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}-{}", self.start, self.end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_range() {
        let r = Range::new(Position::new(0, 0), Position::new(1, 5));
        assert_eq!(r.start, Position::new(0, 0));
        assert_eq!(r.end, Position::new(1, 5));
    }

    #[test]
    fn empty_range() {
        let r = Range::new(Position::new(2, 3), Position::new(2, 3));
        assert!(r.is_empty());
    }

    #[test]
    fn non_empty_range() {
        let r = Range::new(Position::new(0, 0), Position::new(0, 5));
        assert!(!r.is_empty());
    }

    #[test]
    fn display() {
        let r = Range::new(Position::new(1, 2), Position::new(3, 4));
        assert_eq!(format!("{r}"), "1:2-3:4");
    }

    #[test]
    fn serde_roundtrip() {
        let r = Range::new(Position::new(2, 3), Position::new(5, 6));
        let json = serde_json::to_string(&r).unwrap();
        let deserialized: Range = serde_json::from_str(&json).unwrap();
        assert_eq!(r, deserialized);
    }
}
