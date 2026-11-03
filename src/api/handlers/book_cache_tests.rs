//! HTTP contract tests using only temporary storage and a loopback book source.
use crate::{
    api::{handlers, AppState},
    app::config::AppConfig,
    crawler::http_client::HttpClient,
    model::{book::Book, book_chapter::BookChapter, book_source::BookSource, rule::ContentRule},
    parser::rule_engine::RuleEngine,
    service::{
        book_group_service::BookGroupService, book_service::BookService,
        book_source_service::BookSourceService, chapter_update_service::ChapterUpdateService,
        json_document_service::JsonDocumentService, local_epub_book::LocalEpubBookService,
        local_mobi_book::LocalMobiBookService, local_pdf_book::LocalPdfBookService,
        local_txt_book::LocalTxtBookService, update_service::UpdateService,
        user_service::UserService,
    },
    storage::{cache::file_cache::FileCache, db},
};
use axum::{
    extract::Path,
    response::Html,
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

struct Fixture {
    state: AppState,
    root: PathBuf,
    api: String,
    source: String,
    client: reqwest::Client,
    hits: Arc<AtomicUsize>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    pool: sqlx::SqlitePool,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (
        url,
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        }),
    )
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("reader-cache-http-{}", uuid::Uuid::new_v4()));
        let cfg = AppConfig {
            storage_dir: root.to_str().unwrap().into(),
            chapter_update_interval_hours: 0,
            ..Default::default()
        };
        let pool = db::init_pool("sqlite::memory:").await.unwrap();
        let book_service = Arc::new(BookService::new(
            HttpClient::new(5, None).unwrap(),
            RuleEngine::new().unwrap(),
            FileCache::new(root.join("cache")),
            &cfg.storage_dir,
        ));
        let book_source_service = Arc::new(BookSourceService::new(
            db::repo::BookSourceRepo::new(pool.clone()),
            &cfg.storage_dir,
        ));
        let docs = Arc::new(JsonDocumentService::new(pool.clone(), &cfg.storage_dir));
        let user_service = Arc::new(UserService::new(cfg.clone(), pool.clone()));
        let state = AppState {
            config: cfg.clone(),
            book_service: book_service.clone(),
            book_source_service: book_source_service.clone(),
            user_service: user_service.clone(),
            book_group_service: Arc::new(BookGroupService::new(docs.clone())),
            local_txt_book_service: Arc::new(LocalTxtBookService::new(&cfg.storage_dir)),
            local_epub_book_service: Arc::new(LocalEpubBookService::new(&cfg.storage_dir)),
            local_mobi_book_service: Arc::new(LocalMobiBookService::new(&cfg.storage_dir)),
            local_pdf_book_service: Arc::new(LocalPdfBookService::new(&cfg.storage_dir)),
            json_document_service: docs.clone(),
            chapter_update_service: Arc::new(ChapterUpdateService::new(
                book_service,
                book_source_service,
                user_service,
                docs.clone(),
                0,
                1,
            )),
            update_service: Arc::new(UpdateService::new(docs, 5, "test").unwrap()),
        };
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let (source, source_task) = serve(Router::new().route(
            "/text/:speed/:id",
            get(move |Path((speed, id)): Path<(String, String)>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    if speed == "slow" {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                    Html(format!("<div id='content'>chapter {id}</div>"))
                }
            }),
        ))
        .await;
        state
            .book_source_service
            .save(
                "default",
                BookSource {
                    book_source_url: source.clone(),
                    book_source_name: "loopback fixture".into(),
                    rule_content: Some(ContentRule {
                        content: Some("#content@text".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let (api, api_task) = serve(
            Router::new()
                .route(
                    "/content",
                    get(handlers::get_book_content).post(handlers::get_book_content),
                )
                .route("/shelf", get(handlers::get_shelf_book_with_cache_info))
                .route("/clear", post(handlers::delete_book_cache))
                .with_state(state.clone()),
        )
        .await;
        Self {
            state,
            root,
            api,
            source,
            hits,
            tasks: vec![source_task, api_task],
            pool,
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap(),
        }
    }
    async fn content(&self, book: &str, chapter: &str, transport: &str, refresh: bool) -> Value {
        let data = json!({"bookUrl": book, "chapterUrl": chapter, "bookSourceUrl": self.source, "refresh": if refresh { 1 } else { 0 }});
        let url = format!("{}/content", self.api);
        let request = match transport {
            "query" => self.client.get(url).query(&data),
            "form" => self.client.post(url).form(&data),
            _ => self.client.post(url).json(&data),
        };
        let result: Value = request.send().await.unwrap().json().await.unwrap();
        assert_eq!(result["isSuccess"], true, "{result}");
        result["data"].clone()
    }
    async fn shelf(&self, book: &str, chapters: &[String]) {
        self.state
            .book_service
            .save_book(
                "default",
                Book {
                    book_url: book.into(),
                    name: book.into(),
                    origin: self.source.clone(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        self.catalog(book, chapters).await;
    }
    async fn catalog(&self, book: &str, chapters: &[String]) {
        self.state
            .book_service
            .save_chapter_list_cache(
                "default",
                book,
                &chapters
                    .iter()
                    .enumerate()
                    .map(|(i, url)| BookChapter {
                        index: i as i32,
                        url: url.clone(),
                        ..Default::default()
                    })
                    .collect(),
            )
            .await
            .unwrap();
    }
    async fn count(&self, book: &str) -> u64 {
        let result: Value = self
            .client
            .get(format!("{}/shelf", self.api))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["isSuccess"], true, "{result}");
        result["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["bookUrl"] == book)
            .unwrap()["cachedChapterCount"]
            .as_u64()
            .unwrap()
    }
    async fn cleanup(&self) {
        for task in &self.tasks {
            task.abort();
        }
        self.pool.close().await;
        let _ = tokio::fs::remove_dir_all(&self.root).await;
    }
}

#[tokio::test]
async fn http_cache_identity_is_independent_of_source_speed_shelf_order_and_transport() {
    let f = Fixture::new().await;
    for speed in ["fast", "slow"] {
        for pre_shelved in [false, true] {
            for transport in ["json", "query", "form"] {
                let id = format!("{speed}-{pre_shelved}-{transport}");
                // Detail URL and chapter URL deliberately share neither domain nor path.
                let book = format!("https://books.invalid/detail/{id}");
                let chapter = format!("{}/text/{speed}/{id}", f.source);
                if pre_shelved {
                    f.shelf(&book, &[chapter.clone()]).await;
                }
                let hits = f.hits.load(Ordering::SeqCst);
                assert_eq!(
                    f.content(&book, &chapter, transport, false).await,
                    format!("chapter {id}")
                );
                assert_eq!(f.hits.load(Ordering::SeqCst), hits + 1);
                if !pre_shelved {
                    f.shelf(&book, &[chapter.clone()]).await;
                }
                assert_eq!(f.count(&book).await, 1, "{id}");
                f.content(&book, &chapter, transport, false).await;
                assert_eq!(
                    f.hits.load(Ordering::SeqCst),
                    hits + 1,
                    "cached read must not refetch"
                );
            }
        }
    }
    f.cleanup().await;
}

#[tokio::test]
async fn http_refresh_keeps_other_chapters_and_clear_removes_content() {
    let f = Fixture::new().await;
    let book = "https://books.invalid/detail/refresh";
    let chapters = [
        format!("{}/text/fast/one", f.source),
        format!("{}/text/fast/two", f.source),
    ];
    f.shelf(book, &chapters).await;
    for chapter in &chapters {
        f.content(book, chapter, "json", false).await;
    }
    assert_eq!(f.count(book).await, 2);
    f.content(book, &chapters[0], "json", true).await;
    assert_eq!(f.hits.load(Ordering::SeqCst), 3);
    assert_eq!(f.count(book).await, 2);
    f.content(book, &chapters[1], "query", false).await;
    assert_eq!(f.hits.load(Ordering::SeqCst), 3);
    let cleared: Value = f
        .client
        .post(format!("{}/clear", f.api))
        .json(&json!({"bookUrl": book}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(cleared["isSuccess"], true, "{cleared}");
    // Restore only the catalog, so stats cannot trigger a background network fetch.
    f.catalog(book, &chapters).await;
    assert_eq!(f.count(book).await, 0);
    f.content(book, &chapters[0], "json", false).await;
    assert_eq!(f.hits.load(Ordering::SeqCst), 4);
    assert_eq!(f.count(book).await, 1);
    f.cleanup().await;
}
