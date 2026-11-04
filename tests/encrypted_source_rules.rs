use reader_next::{
    crawler::url_analyzer::analyze_url, model::book_source::BookSource,
    parser::rule_engine::RuleEngine,
};
use serde_json::json;

// Public rule expressions only: no exported account headers or live responses.
#[test]
fn json_api_rules_parse_search_details_encrypted_catalog_and_content() {
    let source: BookSource = serde_json::from_value(json!({
        "bookSourceUrl": "http://api.example.test",
        "searchUrl": "{{source.bookSourceUrl}}/search?keyword={{key}}&page={{page}}",
        "ruleSearch": {"bookList": "$.data[*]", "name": "$.novelName", "author": "$.authorName", "bookUrl": "{{source.bookSourceUrl}}/novel/{{$.novelId}}?isSearch=1"},
        "ruleBookInfo": {"init": "$.data", "name": "$.novelName", "author": "$.authorName", "tocUrl": "{{source.bookSourceUrl}}/novel/{{$.novelId}}/chapters"},
        "ruleToc": {"chapterList": "$.data.list[*]", "chapterName": "$.chapterName", "chapterUrl": "$.path\n@js:java.aesBase64DecodeToString(result,\"f041c49714d39908\",\"AES/CBC/PKCS5Padding\",\"0123456789abcdef\");"},
        "ruleContent": {"content": "$.content"}
    })).unwrap();
    let engine = RuleEngine::new().unwrap();
    let url = analyze_url(
        source.search_url.as_deref().unwrap(),
        "Fixture",
        1,
        &source.book_source_url,
        &source,
    )
    .unwrap()
    .url;
    assert_eq!(url, "http://api.example.test/search?keyword=Fixture&page=1");
    let item = json!({"novelId":"123", "novelName":"Fixture", "authorName":"Author"});
    let matches = engine.search_books(&source, &json!({"data":[item.clone()]}).to_string(), &url);
    assert_eq!(matches.len(), 1);
    assert_eq!(
        matches[0].book_url,
        "http://api.example.test/novel/123?isSearch=1"
    );
    let book = engine.book_info(
        &source,
        &json!({"data":item}).to_string(),
        &matches[0].book_url,
        &matches[0].book_url,
    );
    assert_eq!(book.name, "Fixture");
    assert_eq!(
        book.toc_url.as_deref(),
        Some("http://api.example.test/novel/123/chapters")
    );
    let encrypted = "UhQTfQq/qXGCKPd5D+cjxB7Y0AzwiFMYBmcN5nIm2PboUavKiWEIVaAPIhDXbkox";
    let (chapters, _) = engine.chapter_list(
        &source,
        &json!({"data":{"list":[{"chapterName":"First", "path":encrypted}]}}).to_string(),
        book.toc_url.as_deref().unwrap(),
    );
    assert_eq!(chapters.len(), 1);
    assert_eq!(
        chapters[0].url,
        "http://api.lemiyigou.com/655/655791/70398.json"
    );
    assert_eq!(
        engine.content(
            &source,
            r#"{"content":"Fixture chapter text"}"#,
            &chapters[0].url
        ),
        "Fixture chapter text"
    );
}
