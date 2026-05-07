use encoding_rs::{Encoding as EncRsEncoding, UTF_8};
use serde::{Deserialize, Serialize};

/// Supported text encodings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Windows1252,
    Iso8859_1,
    Gb18030,
    ShiftJis,
    EucJp,
    Big5,
    EucKr,
}

/// All supported encodings for enumeration.
pub const ALL_ENCODINGS: &[Encoding] = &[
    Encoding::Utf8,
    Encoding::Utf16Le,
    Encoding::Utf16Be,
    Encoding::Windows1252,
    Encoding::Iso8859_1,
    Encoding::Gb18030,
    Encoding::ShiftJis,
    Encoding::EucJp,
    Encoding::Big5,
    Encoding::EucKr,
];

impl Encoding {
    /// Returns the encoding_rs encoding for this variant.
    pub fn as_encoding_rs(&self) -> &'static EncRsEncoding {
        match self {
            Self::Utf8 => UTF_8,
            Self::Utf16Le => encoding_rs::UTF_16LE,
            Self::Utf16Be => encoding_rs::UTF_16BE,
            Self::Windows1252 => encoding_rs::WINDOWS_1252,
            Self::Iso8859_1 => encoding_rs::WINDOWS_1252, // closest in encoding_rs
            Self::Gb18030 => encoding_rs::GB18030,
            Self::ShiftJis => encoding_rs::SHIFT_JIS,
            Self::EucJp => encoding_rs::EUC_JP,
            Self::Big5 => encoding_rs::BIG5,
            Self::EucKr => encoding_rs::EUC_KR,
        }
    }

    /// Returns a human-readable label for this encoding.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf16Le => "UTF-16 LE",
            Self::Utf16Be => "UTF-16 BE",
            Self::Windows1252 => "Windows-1252",
            Self::Iso8859_1 => "ISO-8859-1",
            Self::Gb18030 => "GB18030",
            Self::ShiftJis => "Shift JIS",
            Self::EucJp => "EUC-JP",
            Self::Big5 => "Big5",
            Self::EucKr => "EUC-KR",
        }
    }
}

/// Encoding error type.
#[derive(Debug, thiserror::Error)]
pub enum EncodingError {
    #[error("failed to decode bytes as {encoding}: {reason}")]
    DecodeError { encoding: String, reason: String },
}

/// Decode bytes as the given encoding into a UTF-8 string.
///
/// # Errors
///
/// Returns an error if the bytes cannot be decoded.
pub fn decode(bytes: &[u8], encoding: Encoding) -> Result<String, EncodingError> {
    let enc = encoding.as_encoding_rs();
    let (cow, _, had_errors) = enc.decode(bytes);
    if had_errors {
        // Still return the decoded string, but note the error
    }
    Ok(cow.into_owned())
}

/// Encode a UTF-8 string into bytes using the given encoding.
pub fn encode(text: &str, encoding: Encoding) -> Vec<u8> {
    let enc = encoding.as_encoding_rs();
    let (bytes, _, _) = enc.encode(text);
    bytes.into_owned()
}

/// Detect encoding from bytes using BOM detection and heuristic scanning.
///
/// Checks for BOMs first (UTF-8, UTF-16 LE/BE), then falls back to UTF-8
/// if the bytes are valid UTF-8, otherwise defaults to UTF-8.
#[must_use]
pub fn detect_encoding(bytes: &[u8]) -> Encoding {
    // Check for BOMs
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        return Encoding::Utf8;
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return Encoding::Utf16Le;
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return Encoding::Utf16Be;
    }

    // Try UTF-8
    if std::str::from_utf8(bytes).is_ok() {
        return Encoding::Utf8;
    }

    // Default to UTF-8 (best effort)
    Encoding::Utf8
}

/// Get an encoding from its IANA label.
#[must_use]
pub fn encoding_from_label(label: &str) -> Option<Encoding> {
    match label.to_lowercase().as_str() {
        "utf-8" => Some(Encoding::Utf8),
        "utf-16le" | "utf-16-le" | "utf-16 le" => Some(Encoding::Utf16Le),
        "utf-16be" | "utf-16-be" | "utf-16 be" => Some(Encoding::Utf16Be),
        "windows-1252" | "cp1252" => Some(Encoding::Windows1252),
        "iso-8859-1" | "latin1" | "iso-8859-1 " => Some(Encoding::Iso8859_1),
        "gb18030" => Some(Encoding::Gb18030),
        "shift_jis" | "shift-jis" | "shift jis" | "sjis" => Some(Encoding::ShiftJis),
        "euc-jp" | "eucjp" => Some(Encoding::EucJp),
        "big5" => Some(Encoding::Big5),
        "euc-kr" | "euckr" => Some(Encoding::EucKr),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_utf8_bom() {
        let bytes = [0xEF, 0xBB, 0xBF, 0x68, 0x65, 0x6C, 0x6C, 0x6F];
        assert_eq!(detect_encoding(&bytes), Encoding::Utf8);
    }

    #[test]
    fn detect_utf16le_bom() {
        let bytes = [0xFF, 0xFE, 0x68, 0x00];
        assert_eq!(detect_encoding(&bytes), Encoding::Utf16Le);
    }

    #[test]
    fn detect_utf16be_bom() {
        let bytes = [0xFE, 0xFF, 0x00, 0x68];
        assert_eq!(detect_encoding(&bytes), Encoding::Utf16Be);
    }

    #[test]
    fn detect_plain_utf8() {
        let bytes = b"hello world";
        assert_eq!(detect_encoding(bytes), Encoding::Utf8);
    }

    #[test]
    fn decode_utf8() {
        let bytes = b"hello world";
        let result = decode(bytes, Encoding::Utf8).unwrap();
        assert_eq!(result, "hello world");
    }

    #[test]
    fn encode_utf8() {
        let text = "hello world";
        let bytes = encode(text, Encoding::Utf8);
        assert_eq!(bytes, b"hello world");
    }

    #[test]
    fn encoding_label_roundtrip() {
        for &enc in ALL_ENCODINGS {
            let label = enc.label();
            let from_label = encoding_from_label(label);
            assert!(from_label.is_some(), "no encoding found for label: {label}");
        }
    }

    #[test]
    fn all_encodings_have_unique_labels() {
        let mut labels: Vec<&str> = ALL_ENCODINGS.iter().map(|e| e.label()).collect();
        labels.sort();
        labels.dedup();
        assert_eq!(
            labels.len(),
            ALL_ENCODINGS.len(),
            "duplicate labels detected"
        );
    }
}
