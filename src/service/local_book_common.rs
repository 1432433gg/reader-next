/// Unified local book type detection.
///
/// Covers local-txt, local-epub, local-pdf, and local-mobi origins/URLs.

pub fn is_local_book_origin(origin: &str) -> bool {
    matches!(
        origin.trim(),
        "local-txt" | "local-epub" | "local-pdf" | "local-mobi"
    )
}

pub fn is_local_book_url(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("local-txt:")
        || url.starts_with("local-epub:")
        || url.starts_with("local-pdf:")
        || url.starts_with("local-mobi:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_local_book_origin() {
        assert!(is_local_book_origin("local-txt"));
        assert!(is_local_book_origin("local-epub"));
        assert!(is_local_book_origin("local-pdf"));
        assert!(is_local_book_origin("local-mobi"));
        assert!(!is_local_book_origin("remote"));
        assert!(is_local_book_origin("local-txt ")); // trimmed internally
    }

    #[test]
    fn test_is_local_book_url() {
        assert!(is_local_book_url("local-txt:abc123#0"));
        assert!(is_local_book_url("local-epub:abc123#0"));
        assert!(is_local_book_url("local-pdf:abc123#0"));
        assert!(is_local_book_url("local-mobi:abc123#0"));
        assert!(!is_local_book_url("https://example.com"));
        assert!(!is_local_book_url("local-"));
    }
}
