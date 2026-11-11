use crate::error::error::AppError;
use crate::model::book_source::{book_source_from_value, BookSource};
use crate::util::text::normalize_source_url;
use crate::util::time::now_ts;
use sqlx::{pool::PoolConnection, Row, Sqlite, SqlitePool, SqliteConnection};
use std::collections::{HashMap, HashSet};

#[derive(Clone)]
pub struct BookSourceRepo {
    pool: SqlitePool,
}

/// A manually started IMMEDIATE transaction that never returns an open
/// transaction to the pool. Dropping the guard detaches the connection, so
/// request cancellation cannot put a transaction-held connection back into
/// circulation.
struct ImmediateSqliteTransaction {
    conn: Option<PoolConnection<Sqlite>>,
    open: bool,
}

impl ImmediateSqliteTransaction {
    async fn begin(pool: &SqlitePool) -> Result<Self, AppError> {
        Self::start(pool.acquire().await?).await
    }

    async fn start(conn: PoolConnection<Sqlite>) -> Result<Self, AppError> {
        // The worker can execute BEGIN even if its caller stops waiting.
        let mut guard = Self {
            conn: Some(conn),
            open: true,
        };
        sqlx::query("BEGIN IMMEDIATE")
            .execute(guard.connection())
            .await?;
        Ok(guard)
    }

    fn connection(&mut self) -> &mut SqliteConnection {
        &mut **self.conn.as_mut().expect("transaction connection is present")
    }

    async fn commit(mut self) -> Result<(), AppError> {
        match sqlx::query("COMMIT").execute(self.connection()).await {
            Ok(_) => {
                self.open = false;
                Ok(())
            }
            Err(error) => {
                // The commit outcome may be uncertain. Do not return this
                // connection to the pool with transaction state attached.
                self.discard_connection();
                Err(error.into())
            }
        }
    }

    async fn rollback(&mut self) -> Result<(), AppError> {
        if !self.open {
            return Ok(());
        }
        match sqlx::query("ROLLBACK").execute(self.connection()).await {
            Ok(_) => {
                self.open = false;
                Ok(())
            }
            Err(error) => {
                self.discard_connection();
                Err(error.into())
            }
        }
    }

    fn discard_connection(&mut self) {
        if let Some(conn) = self.conn.take() {
            drop(conn.detach());
        }
        self.open = false;
    }
}

impl Drop for ImmediateSqliteTransaction {
    fn drop(&mut self) {
        if self.open {
            self.discard_connection();
        }
    }
}

impl BookSourceRepo {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn upsert(
        &self,
        user_ns: &str,
        source: &BookSource,
        json: &str,
    ) -> Result<(), AppError> {
        sqlx::query(
            "INSERT INTO book_sources (user_ns, book_source_url, book_source_name, json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(user_ns, book_source_url) DO UPDATE SET book_source_name=excluded.book_source_name, json=excluded.json, updated_at=excluded.updated_at"
        )
        .bind(user_ns)
        .bind(&source.book_source_url)
        .bind(&source.book_source_name)
        .bind(json)
        .bind(now_ts())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Apply an explicitly selected import while holding a SQLite write lock.
    /// `expected_existing` is present only for an overwrite selected in preview.
    pub async fn import_selected(
        &self,
        user_ns: &str,
        items: Vec<(BookSource, Option<BookSource>)>,
    ) -> Result<(usize, usize), AppError> {
        let mut transaction = ImmediateSqliteTransaction::begin(&self.pool).await?;

        let result: Result<(usize, usize), AppError> = async {
            let rows = sqlx::query(
                "SELECT book_source_url, json FROM book_sources WHERE user_ns=?1",
            )
            .bind(user_ns)
            .fetch_all(transaction.connection())
            .await?;

            let mut existing = HashMap::<String, (String, Option<BookSource>)>::new();
            for row in rows {
                let db_url: String = row.get("book_source_url");
                let raw: String = row.get("json");
                let source = serde_json::from_str::<serde_json::Value>(&raw)
                    .ok()
                    .and_then(|value| book_source_from_value(value).ok());
                existing.insert(
                    normalize_source_url(&db_url),
                    (db_url, source),
                );
            }

            let mut selected_urls = HashSet::new();
            let mut added = 0usize;
            let mut overwritten = 0usize;
            for (mut source, expected_existing) in items {
                let identity = normalize_source_url(&source.book_source_url);
                if identity.is_empty() || !selected_urls.insert(identity.clone()) {
                    return Err(AppError::BadRequest(
                        "导入列表包含空地址或重复地址".to_string(),
                    ));
                }

                let existing_source = existing.get(&identity);
                let db_url = match (existing_source, expected_existing.as_ref()) {
                    (None, None) => {
                        added += 1;
                        source.book_source_url.clone()
                    }
                    (Some((db_url, Some(current))), Some(expected))
                        if same_source(current, expected) =>
                    {
                        overwritten += 1;
                        db_url.clone()
                    }
                    (Some(_), None) => {
                        return Err(AppError::Conflict(
                            "预览后检测到地址已存在；请重新确认导入".to_string(),
                        ));
                    }
                    (None, Some(_)) => {
                        return Err(AppError::Conflict(
                            "预览中的书源已被删除；请重新确认导入".to_string(),
                        ));
                    }
                    (Some(_), Some(_)) => {
                        return Err(AppError::Conflict(
                            "现有书源已发生变化；请重新确认覆盖".to_string(),
                        ));
                    }
                };

                source.book_source_url = db_url;
                let json = serde_json::to_string(&source)
                    .map_err(|error| AppError::BadRequest(error.to_string()))?;
                sqlx::query(
                    "INSERT INTO book_sources (user_ns, book_source_url, book_source_name, json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
                     ON CONFLICT(user_ns, book_source_url) DO UPDATE SET book_source_name=excluded.book_source_name, json=excluded.json, updated_at=excluded.updated_at",
                )
                .bind(user_ns)
                .bind(&source.book_source_url)
                .bind(&source.book_source_name)
                .bind(json)
                .bind(now_ts())
                .execute(transaction.connection())
                .await?;
            }
            Ok((added, overwritten))
        }
        .await;

        match result {
            Ok(counts) => {
                transaction.commit().await?;
                Ok(counts)
            }
            Err(error) => {
                if let Err(rollback_error) = transaction.rollback().await {
                    tracing::error!(?rollback_error, "failed to roll back book source import transaction");
                }
                Err(error)
            }
        }
    }

    pub async fn delete(&self, user_ns: &str, book_source_url: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM book_sources WHERE user_ns=?1 AND book_source_url=?2")
            .bind(user_ns)
            .bind(book_source_url)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_all(&self, user_ns: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM book_sources WHERE user_ns=?1")
            .bind(user_ns)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get(
        &self,
        user_ns: &str,
        book_source_url: &str,
    ) -> Result<Option<String>, AppError> {
        let row =
            sqlx::query("SELECT json FROM book_sources WHERE user_ns=?1 AND book_source_url=?2")
                .bind(user_ns)
                .bind(book_source_url)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.get::<String, _>("json")))
    }

    pub async fn list(&self, user_ns: &str) -> Result<Vec<String>, AppError> {
        let rows =
            sqlx::query("SELECT json FROM book_sources WHERE user_ns=?1 ORDER BY updated_at DESC")
                .bind(user_ns)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .into_iter()
            .map(|r| r.get::<String, _>("json"))
            .collect())
    }

    pub async fn copy_to(&self, from_ns: &str, to_ns: &str) -> Result<i64, AppError> {
        let rows = sqlx::query("SELECT book_source_url, book_source_name, json, updated_at FROM book_sources WHERE user_ns=?1")
            .bind(from_ns)
            .fetch_all(&self.pool)
            .await?;
        let count = rows.len() as i64;
        for row in rows {
            let url: String = row.get("book_source_url");
            let name: String = row.get("book_source_name");
            let json: String = row.get("json");
            let updated_at: i64 = row.get("updated_at");
            sqlx::query(
                "INSERT INTO book_sources (user_ns, book_source_url, book_source_name, json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(user_ns, book_source_url) DO UPDATE SET book_source_name=excluded.book_source_name, json=excluded.json, updated_at=excluded.updated_at"
            )
            .bind(to_ns)
            .bind(&url)
            .bind(&name)
            .bind(&json)
            .bind(updated_at)
            .execute(&self.pool)
            .await?;
        }
        Ok(count)
    }
}

fn same_source(left: &BookSource, right: &BookSource) -> bool {
    match (serde_json::to_value(left), serde_json::to_value(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db;

    fn source(name: &str, url: &str) -> BookSource {
        BookSource {
            book_source_name: name.to_string(),
            book_source_url: url.to_string(),
            ..BookSource::default()
        }
    }

    async fn test_repo(name: &str) -> (BookSourceRepo, sqlx::SqlitePool, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "reader-source-import-{}-{}-{name}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("reader.db");
        let pool = db::init_pool(&format!("sqlite:{}?mode=rwc", database.display()))
            .await
            .unwrap();
        (BookSourceRepo::new(pool.clone()), pool, root)
    }

    #[tokio::test]
    async fn selected_import_rolls_back_all_writes_when_existing_source_changed() {
        let (repo, pool, root) = test_repo("stale-overwrite").await;
        let current = source("Current", "https://example.com/source");
        let mut stale_snapshot = current.clone();
        stale_snapshot.book_source_name = "Old preview".to_string();
        repo.upsert(
            "alice",
            &current,
            &serde_json::to_string(&current).unwrap(),
        )
        .await
        .unwrap();

        let added = source("New", "https://example.com/new");
        let overwritten = source("Updated", "https://example.com/source");
        let result = repo
            .import_selected(
                "alice",
                vec![(added, None), (overwritten, Some(stale_snapshot))],
            )
            .await;

        assert!(matches!(result, Err(AppError::Conflict(_))));
        let saved = repo.list("alice").await.unwrap();
        assert_eq!(saved.len(), 1);
        let current_value: serde_json::Value = serde_json::from_str(&saved[0]).unwrap();
        assert_eq!(current_value["bookSourceName"], "Current");

        pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn selected_import_counts_new_and_explicit_overwrite() {
        let (repo, pool, root) = test_repo("add-and-overwrite").await;
        let current = source("Current", "https://example.com/source");
        repo.upsert(
            "alice",
            &current,
            &serde_json::to_string(&current).unwrap(),
        )
        .await
        .unwrap();

        let added = source("New", "https://example.com/new");
        let overwritten = source("Updated", "https://example.com/source");
        let counts = repo
            .import_selected("alice", vec![(added, None), (overwritten, Some(current))])
            .await
            .unwrap();

        assert_eq!(counts, (1, 1));
        assert_eq!(repo.list("alice").await.unwrap().len(), 2);

        pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn exact_import_snapshots_support_i64_boundaries_and_reject_stale_overwrites() {
        use crate::model::book_source::book_source_snapshot_json;

        let (repo, pool, root) = test_repo("exact-import-snapshot").await;
        let url = "https://example.com/exact";
        for (account, timestamp, response_time) in [
            ("alice", i64::MAX, i64::MIN),
            ("bob", i64::MIN, i64::MAX),
        ] {
            let mut original = source(account, url);
            original.last_update_time = Some(timestamp);
            original.respond_time = Some(response_time);
            assert_eq!(repo.import_selected(account, vec![(original, None)]).await.unwrap(), (1, 0));

            let current = repo.get(account, url).await.unwrap().unwrap();
            let current = book_source_from_value(serde_json::from_str(&current).unwrap()).unwrap();
            assert_eq!(serde_json::to_value(&current).unwrap()["lastUpdateTime"].as_i64(), Some(timestamp));
            let snapshot = book_source_snapshot_json(&current).unwrap();
            assert_eq!(snapshot["lastUpdateTime"], timestamp.to_string());
            assert_eq!(snapshot["respondTime"], response_time.to_string());
            let expected: BookSource = serde_json::from_str(&snapshot.to_string()).unwrap();
            let mut updated = current;
            updated.book_source_name.push_str(" updated");
            assert_eq!(
                repo.import_selected(account, vec![(updated.clone(), Some(expected.clone()))]).await.unwrap(),
                (0, 1)
            );
            let result = repo.import_selected(account, vec![(updated, Some(expected))]).await;
            assert!(matches!(result, Err(AppError::Conflict(_))));
        }
        assert!(repo.get("alice", url).await.unwrap().unwrap().contains("alice updated"));
        assert!(repo.get("bob", url).await.unwrap().unwrap().contains("bob updated"));

        pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancelled_import_discards_connection_and_rolls_back_uncommitted_rows() {
        let (repo, pool, root) = test_repo("cancelled-import").await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task_pool = pool.clone();
        let task = tokio::spawn(async move {
            let mut transaction = ImmediateSqliteTransaction::begin(&task_pool).await.unwrap();
            sqlx::query(
                "INSERT INTO book_sources (user_ns, book_source_url, book_source_name, json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .bind("alice")
            .bind("https://example.com/uncommitted")
            .bind("Uncommitted")
            .bind("{}")
            .bind(0i64)
            .execute(transaction.connection())
            .await
            .unwrap();
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });

        started_rx.await.unwrap();
        task.abort();
        let _ = task.await;

        let row = sqlx::query(
            "SELECT COUNT(*) AS count FROM book_sources WHERE user_ns=?1 AND book_source_url=?2",
        )
        .bind("alice")
        .bind("https://example.com/uncommitted")
        .fetch_one(&pool)
        .await
        .unwrap();
        let count: i64 = row.get("count");
        assert_eq!(count, 0);

        let saved = source("After cancellation", "https://example.com/after-cancel");
        repo.upsert("alice", &saved, &serde_json::to_string(&saved).unwrap())
            .await
            .unwrap();
        assert_eq!(repo.list("alice").await.unwrap().len(), 1);

        pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_begin_discards_the_pool_connection() {
        use std::future::{poll_fn, Future};
        use std::task::Poll;
        use std::time::Duration;

        let (repo, pool, root) = test_repo("cancelled-begin").await;
        let mut blocker = ImmediateSqliteTransaction::begin(&pool).await.unwrap();
        let conn = pool.acquire().await.unwrap();
        let pool_size = pool.size();
        let mut begin = Box::pin(ImmediateSqliteTransaction::start(conn));
        // The writer lock keeps BEGIN pending after its first poll dispatches
        // the command to the idle connection worker.
        poll_fn(|cx| {
            assert!(begin.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(begin);
        assert_eq!(pool.size(), pool_size - 1);
        blocker.rollback().await.unwrap();
        drop(blocker);

        let saved = source("After cancelled BEGIN", "https://example.com/cancelled-begin");
        let counts = tokio::time::timeout(
            Duration::from_secs(10),
            repo.import_selected("bob", vec![(saved, None)]),
        )
        .await
        .expect("the cancelled BEGIN must release the writer lock")
        .unwrap();
        assert_eq!(counts, (1, 0));
        assert_eq!(repo.list("bob").await.unwrap().len(), 1);
        assert!(repo.list("alice").await.unwrap().is_empty());

        pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn commit_and_rollback_failures_discard_transaction_connections() {
        let (repo, pool, root) = test_repo("transaction-cleanup-failures").await;

        let mut commit_transaction = ImmediateSqliteTransaction::begin(&pool).await.unwrap();
        sqlx::query("ROLLBACK")
            .execute(commit_transaction.connection())
            .await
            .unwrap();
        assert!(commit_transaction.commit().await.is_err());

        let mut rollback_transaction = ImmediateSqliteTransaction::begin(&pool).await.unwrap();
        sqlx::query("ROLLBACK")
            .execute(rollback_transaction.connection())
            .await
            .unwrap();
        assert!(rollback_transaction.rollback().await.is_err());

        let saved = source("After failed cleanup", "https://example.com/after-cleanup");
        repo.upsert("alice", &saved, &serde_json::to_string(&saved).unwrap())
            .await
            .unwrap();
        assert_eq!(repo.list("alice").await.unwrap().len(), 1);

        pool.close().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
