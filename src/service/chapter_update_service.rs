//! 书架新章节自动检查。
//!
//! 后台定时（默认每 24 小时）遍历每个用户书架上的网络书，强制刷新目录，
//! 发现章节数变多时更新书架里的 `totalChapterNum` / `latestChapterTitle` /
//! `lastCheckTime`，前端书架据此显示「N 章未读」。目录缓存也会一起刷新，
//! 打开书时直接能看到新章节。
//!
//! 同一个书源的书依次检查、中间有间隔，不同书源并发检查，避免短时间内
//! 大量请求同一个网站被封。

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::error::AppError;
use crate::model::book::Book;
use crate::model::book_source::BookSource;
use crate::service::book_service::BookService;
use crate::service::book_source_service::BookSourceService;
use crate::service::json_document_service::JsonDocumentService;
use crate::service::local_book_common::{is_local_book_origin, is_local_book_url};
use crate::service::user_service::UserService;
use crate::util::text::{normalize_source_url, repair_encoded_url};

const APP_NAMESPACE: &str = "_app";
const SCHEDULE_DOC: &str = "chapter-update-schedule";
const STATUS_DOC: &str = "chapter-update-status";
/// 同一书源内两本书之间的间隔
const SAME_SOURCE_DELAY: Duration = Duration::from_millis(1500);
/// 服务启动后至少等这么久再跑第一次检查
const STARTUP_DELAY: Duration = Duration::from_secs(60);
/// 状态里最多保留多少本有更新的书
const MAX_UPDATED_BOOKS: usize = 200;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 书架里的时间字段有的是秒、有的是毫秒，统一成毫秒
fn normalize_ts_ms(value: Option<i64>) -> i64 {
    match value {
        Some(v) if v > 0 && v < 1_000_000_000_000 => v * 1000,
        Some(v) if v > 0 => v,
        _ => 0,
    }
}

/// 把上次累计的未读更新和本次结果合并：读过的书清掉，新发现的叠加
pub fn merge_pending(
    previous: &[PendingBook],
    shelf: &[Book],
    updates: &[(String, i32, Option<String>)],
    now: i64,
) -> Vec<PendingBook> {
    let mut out: Vec<PendingBook> = Vec::new();
    for book in shelf {
        let last_read = normalize_ts_ms(book.dur_chapter_time);
        let carried = previous
            .iter()
            .find(|p| p.book_url == book.book_url)
            .filter(|p| last_read < p.detected_at);
        let fresh = updates.iter().find(|(url, _, _)| *url == book.book_url);
        let entry = match (carried, fresh) {
            (Some(prev), Some((_, n, latest))) => PendingBook {
                new_chapters: prev.new_chapters + n,
                latest_chapter_title: latest.clone().or_else(|| prev.latest_chapter_title.clone()),
                ..prev.clone()
            },
            (Some(prev), None) => prev.clone(),
            (None, Some((_, n, latest))) => PendingBook {
                name: book.name.clone(),
                book_url: book.book_url.clone(),
                new_chapters: *n,
                detected_at: now,
                latest_chapter_title: latest.clone(),
            },
            (None, None) => continue,
        };
        out.push(entry);
    }
    out.sort_by(|a, b| b.detected_at.cmp(&a.detected_at));
    out.truncate(MAX_UPDATED_BOOKS);
    out
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ScheduleState {
    last_run_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdatedBook {
    pub name: String,
    pub author: String,
    pub book_url: String,
    pub new_chapters: i32,
    pub latest_chapter_title: Option<String>,
}

/// 还没读过的新章节：多次检查累计，打开这本书后清除
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PendingBook {
    pub name: String,
    pub book_url: String,
    pub new_chapters: i32,
    /// 第一次发现（自上次阅读以来）新章节的时间，毫秒
    pub detected_at: i64,
    pub latest_chapter_title: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct FailedBook {
    pub name: String,
    pub book_url: String,
    pub error: String,
}

/// 某个用户最近一次检查的结果
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct UserUpdateReport {
    pub started_at: i64,
    pub finished_at: i64,
    pub checked: usize,
    pub updated: usize,
    pub failed: usize,
    pub skipped: usize,
    pub new_chapters: i64,
    /// 本次检查发现的更新
    pub updated_books: Vec<UpdatedBook>,
    pub failed_books: Vec<FailedBook>,
    /// 累计还没读的更新（书架上的「新 N 章」标记用这个）
    pub pending_books: Vec<PendingBook>,
}

/// 返回给前端的状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterUpdateStatus {
    pub enabled: bool,
    pub interval_hours: u64,
    pub running: bool,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub report: Option<UserUpdateReport>,
}

/// 单本书的检查结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookCheckOutcome {
    Updated { new_chapters: i32 },
    Unchanged,
    Skipped,
    Failed(String),
}

pub struct ChapterUpdateService {
    book_service: Arc<BookService>,
    book_source_service: Arc<BookSourceService>,
    user_service: Arc<UserService>,
    docs: Arc<JsonDocumentService>,
    interval: Option<Duration>,
    concurrency: usize,
    run_lock: Arc<Mutex<()>>,
}

/// 是否需要自动检查这本书（本地书、标记为不更新的书跳过）
pub fn should_check_book(book: &Book) -> bool {
    if book.can_update == Some(false) {
        return false;
    }
    let origin = book.origin.trim();
    if origin.is_empty() || is_local_book_origin(origin) || is_local_book_url(&book.book_url) {
        return false;
    }
    // RSS 文章等非书籍条目没有可用的书源地址
    origin.starts_with("http://") || origin.starts_with("https://") || origin.contains("://")
}

/// 新目录与旧记录对比：返回新增章节数（目录变短时为 0）
pub fn count_new_chapters(old_total: Option<i32>, new_total: usize) -> i32 {
    let new_total = new_total as i32;
    match old_total {
        Some(old) if old > 0 => (new_total - old).max(0),
        // 之前从没记录过章节数：这次只是补记录，不算更新
        _ => 0,
    }
}

impl ChapterUpdateService {
    pub fn new(
        book_service: Arc<BookService>,
        book_source_service: Arc<BookSourceService>,
        user_service: Arc<UserService>,
        docs: Arc<JsonDocumentService>,
        interval_hours: u64,
        concurrency: usize,
    ) -> Self {
        let interval = if interval_hours == 0 {
            None
        } else {
            Some(Duration::from_secs(interval_hours * 3600))
        };
        Self {
            book_service,
            book_source_service,
            user_service,
            docs,
            interval,
            concurrency: concurrency.max(1),
            run_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn enabled(&self) -> bool {
        self.interval.is_some()
    }

    pub fn is_running(&self) -> bool {
        self.run_lock.try_lock().is_err()
    }

    /// 启动后台定时任务。重启服务不会立刻重跑：按上次检查时间计算下一次。
    pub fn spawn_scheduler(self: &Arc<Self>) {
        let Some(interval) = self.interval else {
            tracing::info!("chapter update check disabled (CHAPTER_UPDATE_INTERVAL_HOURS=0)");
            return;
        };
        let this = self.clone();
        tokio::spawn(async move {
            tracing::info!(
                "chapter update check scheduled every {} hours",
                interval.as_secs() / 3600
            );
            loop {
                let last = this.load_schedule().await.last_run_at;
                let elapsed_ms = (now_ms() - last).max(0) as u64;
                let wait = interval
                    .saturating_sub(Duration::from_millis(elapsed_ms))
                    .max(STARTUP_DELAY);
                tokio::time::sleep(wait).await;
                if let Err(err) = this.run_all().await {
                    tracing::warn!("chapter update check failed: {err:?}");
                    // 出错时也记录时间，避免持续重试
                    this.save_schedule(now_ms()).await;
                }
            }
        });
    }

    /// 检查所有用户的书架
    pub async fn run_all(&self) -> Result<(), AppError> {
        let Ok(_guard) = self.run_lock.try_lock() else {
            tracing::info!("chapter update check already running, skip");
            return Ok(());
        };
        let started = now_ms();
        let mut namespaces = vec!["default".to_string()];
        namespaces.extend(self.user_service.list_usernames().await?);
        let mut seen = HashSet::new();
        namespaces.retain(|ns| seen.insert(ns.clone()));

        tracing::info!(
            "chapter update check started for {} namespaces",
            namespaces.len()
        );
        for ns in &namespaces {
            match self.check_namespace(ns).await {
                Ok(report) => tracing::info!(
                    "chapter update [{ns}]: checked={} updated={} failed={} new_chapters={}",
                    report.checked,
                    report.updated,
                    report.failed,
                    report.new_chapters
                ),
                Err(err) => tracing::warn!("chapter update [{ns}] failed: {err:?}"),
            }
        }
        self.save_schedule(started).await;
        Ok(())
    }

    /// 只检查一个用户的书架（书架页「检查更新」按钮）。
    /// 在后台执行，立即返回；已经有检查在跑时返回 `false`。
    /// 前端通过 [`Self::status`] 的 `running` 字段轮询是否完成。
    pub fn start_user_check(self: &Arc<Self>, user_ns: String) -> bool {
        let Ok(guard) = self.run_lock.clone().try_lock_owned() else {
            return false;
        };
        let this = self.clone();
        tokio::spawn(async move {
            let _guard = guard;
            match this.check_namespace(&user_ns).await {
                Ok(report) => tracing::info!(
                    "manual chapter update [{user_ns}]: checked={} updated={} failed={}",
                    report.checked,
                    report.updated,
                    report.failed
                ),
                Err(err) => tracing::warn!("manual chapter update [{user_ns}] failed: {err:?}"),
            }
        });
        true
    }

    pub async fn status(&self, user_ns: &str) -> ChapterUpdateStatus {
        let last = self.load_schedule().await.last_run_at;
        let last_run_at = (last > 0).then_some(last);
        let next_run_at = self
            .interval
            .zip(last_run_at)
            .map(|(interval, last)| last + interval.as_millis() as i64);
        let report = self.load_report(user_ns).await;
        ChapterUpdateStatus {
            enabled: self.enabled(),
            interval_hours: self.interval.map(|d| d.as_secs() / 3600).unwrap_or(0),
            running: self.is_running(),
            last_run_at,
            next_run_at,
            report,
        }
    }

    async fn check_namespace(&self, user_ns: &str) -> Result<UserUpdateReport, AppError> {
        let mut report = UserUpdateReport {
            started_at: now_ms(),
            ..Default::default()
        };
        let shelf = self.book_service.get_bookshelf(user_ns).await?;

        // 按书源分组：同一书源串行，不同书源并发
        let mut groups: BTreeMap<String, Vec<Book>> = BTreeMap::new();
        for book in shelf {
            if should_check_book(&book) {
                groups
                    .entry(normalize_source_url(&book.origin))
                    .or_default()
                    .push(book);
            } else {
                report.skipped += 1;
            }
        }

        let results: Vec<(Book, BookCheckOutcome)> = stream::iter(groups.into_values())
            .map(|books| async move {
                let mut out = Vec::with_capacity(books.len());
                for (i, book) in books.into_iter().enumerate() {
                    if i > 0 {
                        tokio::time::sleep(SAME_SOURCE_DELAY).await;
                    }
                    let outcome = self.check_book(user_ns, &book).await;
                    out.push((book, outcome));
                }
                out
            })
            .buffer_unordered(self.concurrency)
            .flat_map(stream::iter)
            .collect()
            .await;

        for (book, outcome) in results {
            match outcome {
                BookCheckOutcome::Updated { new_chapters } => {
                    report.checked += 1;
                    report.updated += 1;
                    report.new_chapters += new_chapters as i64;
                    let latest = self
                        .book_service
                        .get_shelf_book(user_ns, &book.book_url)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|b| b.latest_chapter_title);
                    report.updated_books.push(UpdatedBook {
                        name: book.name,
                        author: book.author,
                        book_url: book.book_url,
                        new_chapters,
                        latest_chapter_title: latest,
                    });
                }
                BookCheckOutcome::Unchanged => report.checked += 1,
                BookCheckOutcome::Skipped => report.skipped += 1,
                BookCheckOutcome::Failed(error) => {
                    report.failed += 1;
                    report.failed_books.push(FailedBook {
                        name: book.name,
                        book_url: book.book_url,
                        error,
                    });
                }
            }
        }
        report
            .updated_books
            .sort_by(|a, b| b.new_chapters.cmp(&a.new_chapters));
        report.updated_books.truncate(MAX_UPDATED_BOOKS);
        report.failed_books.truncate(MAX_UPDATED_BOOKS);
        report.finished_at = now_ms();

        // 重新读一次书架（拿到检查期间的最新阅读进度），合并累计的未读更新
        let previous = self.load_report(user_ns).await.unwrap_or_default();
        let shelf_now = self
            .book_service
            .get_bookshelf(user_ns)
            .await
            .unwrap_or_default();
        let updates: Vec<(String, i32, Option<String>)> = report
            .updated_books
            .iter()
            .map(|b| {
                (
                    b.book_url.clone(),
                    b.new_chapters,
                    b.latest_chapter_title.clone(),
                )
            })
            .collect();
        report.pending_books = merge_pending(
            &previous.pending_books,
            &shelf_now,
            &updates,
            report.finished_at,
        );

        if let Err(err) = self.docs.set_value(user_ns, STATUS_DOC, &report).await {
            tracing::warn!("save chapter update status [{user_ns}] failed: {err:?}");
        }
        Ok(report)
    }

    async fn check_book(&self, user_ns: &str, book: &Book) -> BookCheckOutcome {
        let source = match self.resolve_source(user_ns, &book.origin).await {
            Some(source) => source,
            None => return BookCheckOutcome::Failed("书源不存在".to_string()),
        };
        if source.enabled == Some(false) {
            return BookCheckOutcome::Skipped;
        }

        let toc_url = match book
            .toc_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
        {
            Some(url) => repair_encoded_url(url),
            None => match self
                .book_service
                .get_book_info(user_ns, &source, &repair_encoded_url(&book.book_url))
                .await
            {
                Ok(info) => repair_encoded_url(info.toc_url.as_deref().unwrap_or(&book.book_url)),
                Err(err) => return BookCheckOutcome::Failed(format!("获取详情失败: {err}")),
            },
        };

        let chapters = match self
            .book_service
            .get_chapter_list_with_cache(user_ns, &source, &toc_url, true)
            .await
        {
            Ok(chapters) if !chapters.is_empty() => chapters,
            Ok(_) => return BookCheckOutcome::Failed("目录为空".to_string()),
            Err(err) => return BookCheckOutcome::Failed(format!("获取目录失败: {err}")),
        };

        // 重新读取最新的书架记录再写回，避免覆盖检查期间的阅读进度
        let current = match self
            .book_service
            .get_shelf_book(user_ns, &book.book_url)
            .await
        {
            Ok(Some(current)) => current,
            // 检查期间书被移出书架
            Ok(None) => return BookCheckOutcome::Skipped,
            Err(err) => return BookCheckOutcome::Failed(err.to_string()),
        };
        let new_chapters = count_new_chapters(current.total_chapter_num, chapters.len());
        let mut updated = current;
        updated.total_chapter_num = Some(chapters.len() as i32);
        if let Some(last) = chapters.last() {
            updated.latest_chapter_title = Some(last.title.clone());
        }
        if updated
            .toc_url
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
        {
            updated.toc_url = Some(toc_url);
        }
        updated.last_check_time = Some(now_ms());
        if let Err(err) = self.book_service.save_book(user_ns, updated).await {
            return BookCheckOutcome::Failed(format!("保存失败: {err}"));
        }

        if new_chapters > 0 {
            BookCheckOutcome::Updated { new_chapters }
        } else {
            BookCheckOutcome::Unchanged
        }
    }

    async fn resolve_source(&self, user_ns: &str, origin: &str) -> Option<BookSource> {
        let normalized = normalize_source_url(origin);
        if normalized.is_empty() {
            return None;
        }
        if let Ok(Some(source)) = self.book_source_service.get(user_ns, &normalized).await {
            return Some(source);
        }
        self.book_source_service
            .list(user_ns)
            .await
            .ok()?
            .into_iter()
            .find(|s| normalize_source_url(&s.book_source_url) == normalized)
    }

    async fn load_report(&self, user_ns: &str) -> Option<UserUpdateReport> {
        self.docs
            .get_value(user_ns, STATUS_DOC)
            .await
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value::<UserUpdateReport>(v).ok())
    }

    async fn load_schedule(&self) -> ScheduleState {
        self.docs
            .get_value(APP_NAMESPACE, SCHEDULE_DOC)
            .await
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    async fn save_schedule(&self, last_run_at: i64) {
        let state = ScheduleState { last_run_at };
        if let Err(err) = self
            .docs
            .set_value(APP_NAMESPACE, SCHEDULE_DOC, &state)
            .await
        {
            tracing::warn!("save chapter update schedule failed: {err:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(origin: &str, url: &str) -> Book {
        Book {
            name: "测试".to_string(),
            origin: origin.to_string(),
            book_url: url.to_string(),
            ..Book::default()
        }
    }

    #[test]
    fn checks_online_books_only() {
        assert!(should_check_book(&book(
            "https://example.com",
            "https://example.com/b/1"
        )));
        assert!(!should_check_book(&book("local-txt", "local-txt:abc")));
        assert!(!should_check_book(&book("local-epub", "local-epub:abc")));
        assert!(!should_check_book(&book("", "https://example.com/b/1")));
        let mut finished = book("https://example.com", "https://example.com/b/1");
        finished.can_update = Some(false);
        assert!(!should_check_book(&finished));
    }

    fn shelf_book(url: &str, read_at: Option<i64>) -> Book {
        Book {
            name: url.to_string(),
            book_url: url.to_string(),
            origin: "https://example.com".to_string(),
            dur_chapter_time: read_at,
            ..Book::default()
        }
    }

    #[test]
    fn pending_updates_accumulate_until_book_is_read() {
        // 真实时间：秒级的阅读进度时间 + 毫秒级的检查时间
        let read_secs = 1_700_000_000; // 上次阅读（秒）
        let t1 = 1_700_000_100_000; // 第一次检查（毫秒）
        let shelf = vec![shelf_book("a", Some(read_secs)), shelf_book("b", None)];

        // 第一次检查：a 新增 2 章
        let first = merge_pending(&[], &shelf, &[("a".into(), 2, Some("第5章".into()))], t1);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].new_chapters, 2);
        assert_eq!(first[0].detected_at, t1);

        // 第二次检查：没读，a 又新增 1 章 → 累计 3 章，发现时间不变
        let second = merge_pending(
            &first,
            &shelf,
            &[("a".into(), 1, Some("第6章".into()))],
            t1 + 1000,
        );
        assert_eq!(second[0].new_chapters, 3);
        assert_eq!(second[0].detected_at, t1);
        assert_eq!(second[0].latest_chapter_title.as_deref(), Some("第6章"));

        // 第三次检查：没有新章节，但还没读 → 保留标记
        let third = merge_pending(&second, &shelf, &[], t1 + 2000);
        assert_eq!(third[0].new_chapters, 3);

        // 读过之后（进度时间晚于发现时间；秒和毫秒两种写法都认）→ 标记清除
        let read_after_secs = vec![shelf_book("a", Some(t1 / 1000 + 10)), shelf_book("b", None)];
        assert!(merge_pending(&third, &read_after_secs, &[], t1 + 3000).is_empty());
        let read_after_ms = vec![shelf_book("a", Some(t1 + 10)), shelf_book("b", None)];
        assert!(merge_pending(&third, &read_after_ms, &[], t1 + 3000).is_empty());

        // 书被移出书架 → 标记清除
        assert!(merge_pending(&third, &[shelf_book("b", None)], &[], t1 + 3000).is_empty());
    }

    #[test]
    fn counts_new_chapters() {
        assert_eq!(count_new_chapters(Some(100), 103), 3);
        assert_eq!(count_new_chapters(Some(100), 100), 0);
        assert_eq!(count_new_chapters(Some(100), 90), 0);
        assert_eq!(count_new_chapters(None, 50), 0);
        assert_eq!(count_new_chapters(Some(0), 50), 0);
    }
}
