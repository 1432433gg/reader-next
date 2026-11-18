use crate::{error::error::AppError, service::json_document_service::JsonDocumentService};
use serde::{Deserialize, Serialize};
const DOCUMENT: &str = "source-subscriptions-v1";
const MAX_ITEMS: usize = 5000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSubscription {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<i64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SubscriptionDocument {
    pub revision: u64,
    pub items: Vec<SourceSubscription>,
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SubscriptionOperation {
    Add {
        url: String,
        #[serde(default)]
        name: Option<String>,
    },
    Remove {
        url: String,
    },
    Synced {
        url: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        existing_only: bool,
    },
    Update {
        url: String,
        new_url: String,
        #[serde(default)]
        name: Option<String>,
        expected_name: Option<String>,
    },
    Migrate {
        items: Vec<SourceSubscription>,
    },
}
fn clean_name(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let name = raw.unwrap_or("").trim();
    if name.chars().count() > 80 {
        return Err(AppError::BadRequest("订阅名称最多80个字符".into()));
    }
    Ok((!name.is_empty()).then(|| name.to_owned()))
}
fn clean_url(raw: &str) -> Result<String, AppError> {
    let value = raw.trim();
    let parsed =
        url::Url::parse(value).map_err(|_| AppError::BadRequest("无效的订阅链接".into()))?;
    if value.len() > 8192
        || !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
    {
        return Err(AppError::BadRequest("无效的订阅链接".into()));
    }
    Ok(value.to_owned())
}
fn decode(raw: Option<&str>) -> Result<SubscriptionDocument, AppError> {
    raw.map(serde_json::from_str)
        .transpose()
        .map(|doc| doc.unwrap_or_default())
        .map_err(|_| AppError::Internal(anyhow::anyhow!("invalid subscription document")))
}
pub async fn read(
    service: &JsonDocumentService,
    namespace: &str,
) -> Result<SubscriptionDocument, AppError> {
    decode(service.get_raw(namespace, DOCUMENT).await?.as_deref())
}
pub async fn apply(
    service: &JsonDocumentService,
    namespace: &str,
    operation: SubscriptionOperation,
) -> Result<SubscriptionDocument, AppError> {
    let now = chrono::Utc::now().timestamp_millis();
    // Validate everything before entering the write loop.
    let operation = match operation {
        SubscriptionOperation::Add { url, name } => SubscriptionOperation::Add {
            url: clean_url(&url)?,
            name: clean_name(name.as_deref())?,
        },
        SubscriptionOperation::Remove { url } => SubscriptionOperation::Remove {
            url: clean_url(&url)?,
        },
        SubscriptionOperation::Synced {
            url,
            name,
            existing_only,
        } => SubscriptionOperation::Synced {
            url: clean_url(&url)?,
            name: clean_name(name.as_deref())?,
            existing_only,
        },
        SubscriptionOperation::Update {
            url,
            new_url,
            name,
            expected_name,
        } => SubscriptionOperation::Update {
            url: clean_url(&url)?,
            new_url: clean_url(&new_url)?,
            name: clean_name(name.as_deref())?,
            expected_name: clean_name(expected_name.as_deref())?,
        },
        SubscriptionOperation::Migrate { items } => {
            if items.len() > MAX_ITEMS {
                return Err(AppError::BadRequest("本机订阅过多".into()));
            }
            SubscriptionOperation::Migrate {
                items: items
                    .into_iter()
                    .map(|item| {
                        Ok(SourceSubscription {
                            url: clean_url(&item.url)?,
                            name: clean_name(item.name.as_deref())?,
                            last_synced_at: item
                                .last_synced_at
                                .filter(|time| *time > 0 && *time <= now),
                        })
                    })
                    .collect::<Result<_, AppError>>()?,
            }
        }
    };
    for _ in 0..12 {
        let raw = service.get_raw(namespace, DOCUMENT).await?;
        let mut doc = decode(raw.as_deref())?;
        let before = doc.items.clone();
        match &operation {
            SubscriptionOperation::Remove { url } => doc.items.retain(|item| &item.url != url),
            SubscriptionOperation::Add { url, name } => {
                if let Some(item) = doc.items.iter().find(|item| &item.url == url) {
                    if name.is_some() && &item.name != name {
                        return Err(AppError::BadRequest("该链接已存在，请编辑已有订阅".into()));
                    }
                } else {
                    doc.items.push(SourceSubscription {
                        url: url.clone(),
                        name: name.clone(),
                        last_synced_at: None,
                    });
                }
            }
            SubscriptionOperation::Synced {
                url,
                name,
                existing_only,
            } => {
                if !doc.items.iter().any(|item| &item.url == url) && !existing_only {
                    doc.items.push(SourceSubscription {
                        url: url.clone(),
                        name: name.clone(),
                        last_synced_at: None,
                    });
                }
                if let Some(item) = doc.items.iter_mut().find(|item| &item.url == url) {
                    item.last_synced_at = Some(item.last_synced_at.unwrap_or(0).max(now));
                }
            }
            SubscriptionOperation::Update {
                url,
                new_url,
                name,
                expected_name,
            } => {
                let index = doc
                    .items
                    .iter()
                    .position(|item| &item.url == url)
                    .ok_or_else(|| {
                        AppError::BadRequest("订阅已修改或删除，请重新读取后编辑".into())
                    })?;
                if clean_name(doc.items[index].name.as_deref())? != *expected_name {
                    return Err(AppError::BadRequest(
                        "订阅已被其他设备修改，请重新读取后编辑".into(),
                    ));
                }
                if url != new_url && doc.items.iter().any(|item| &item.url == new_url) {
                    return Err(AppError::BadRequest("新链接已属于其他订阅".into()));
                }
                let item = &mut doc.items[index];
                item.name = name.clone();
                if url != new_url {
                    item.url = new_url.clone();
                    item.last_synced_at = None;
                }
            }
            SubscriptionOperation::Migrate { items } => {
                for incoming in items {
                    if let Some(item) = doc.items.iter_mut().find(|item| item.url == incoming.url) {
                        if clean_name(item.name.as_deref())?.is_none() {
                            item.name = incoming.name.clone();
                        }
                        item.last_synced_at = item.last_synced_at.max(incoming.last_synced_at);
                    } else {
                        doc.items.push(incoming.clone());
                    }
                }
            }
        }
        if doc.items.len() > MAX_ITEMS {
            return Err(AppError::BadRequest("订阅数量已达上限".into()));
        }
        if before == doc.items {
            return Ok(doc);
        }
        doc.revision = doc
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::BadRequest("订阅版本已达上限".into()))?;
        let next = serde_json::to_string(&doc).map_err(|e| AppError::Internal(e.into()))?;
        if service
            .compare_and_set_raw(namespace, DOCUMENT, raw.as_deref(), &next)
            .await?
        {
            return Ok(doc);
        }
        tokio::task::yield_now().await;
    }
    Err(AppError::BadRequest(
        "订阅正在被其他设备修改，请重试".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::init_pool;
    async fn change(
        service: &JsonDocumentService,
        value: serde_json::Value,
    ) -> Result<SubscriptionDocument, AppError> {
        apply(service, "a", serde_json::from_value(value).unwrap()).await
    }
    #[tokio::test]
    async fn named_updates_are_atomic_and_stale_sync_cannot_resurrect_old_urls() {
        use serde_json::json;
        let pool = init_pool("sqlite::memory:").await.unwrap();
        let service = JsonDocumentService::new(pool.clone(), "unused");
        change(
            &service,
            json!({"operation":"add","url":"https://one.example/?q=keep","name":" 原名😀 "}),
        )
        .await
        .unwrap();
        let synced=change(&service,json!({"operation":"synced","url":"https://one.example/?q=keep","name":"must not replace"})).await.unwrap();
        assert_eq!(synced.items[0].name.as_deref(), Some("原名😀"));
        let renamed=change(&service,json!({"operation":"update","url":"https://one.example/?q=keep","newUrl":"https://one.example/?q=keep","expectedName":"原名😀","name":"新名"})).await.unwrap();
        assert_eq!(
            renamed.items[0].last_synced_at,
            synced.items[0].last_synced_at
        );
        assert!(change(&service,json!({"operation":"update","url":"https://one.example/?q=keep","newUrl":"https://one.example/?q=keep","expectedName":"原名😀","name":"stale"})).await.is_err());
        let moved=change(&service,json!({"operation":"update","url":"https://one.example/?q=keep","newUrl":"https://new.example/?q=keep#frag","expectedName":"新名","name":""})).await.unwrap();
        assert!(moved.items[0].last_synced_at.is_none());
        assert!(moved.items[0].name.is_none());
        let late=change(&service,json!({"operation":"synced","url":"https://one.example/?q=keep","existingOnly":true,"name":"原名😀"})).await.unwrap();
        assert_eq!(late, moved);
        change(
            &service,
            json!({"operation":"add","url":"https://two.example/","name":"B"}),
        )
        .await
        .unwrap();
        let before = read(&service, "a").await.unwrap();
        assert!(change(&service,json!({"operation":"update","url":"https://new.example/?q=keep#frag","newUrl":"https://two.example/","expectedName":null,"name":"clash"})).await.is_err());
        assert_eq!(read(&service, "a").await.unwrap(), before);
        assert!(read(&service, "b").await.unwrap().items.is_empty());
        pool.close().await;
    }
    #[tokio::test]
    async fn unicode_name_limits_migration_and_concurrent_edits_preserve_data() {
        use serde_json::json;
        let pool = init_pool("sqlite::memory:").await.unwrap();
        let service = JsonDocumentService::new(pool.clone(), "unused");
        change(
            &service,
            json!({"operation":"add","url":"https://a.example/","name":"😀".repeat(80)}),
        )
        .await
        .unwrap();
        assert!(change(
            &service,
            json!({"operation":"add","url":"https://bad.example/","name":"😀".repeat(81)})
        )
        .await
        .is_err());
        change(
            &service,
            json!({"operation":"add","url":"https://a.example/"}),
        )
        .await
        .unwrap();
        change(&service,json!({"operation":"migrate","items":[{"url":"https://a.example/","lastSyncedAt":1000}]})).await.unwrap();
        assert_eq!(
            read(&service, "a").await.unwrap().items[0]
                .name
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            80
        );
        let one = change(
            &service,
            json!({"operation":"update","url":"https://a.example/","newUrl":"https://a.example/","expectedName":"😀".repeat(80),"name":"one"}),
        );
        let two = change(
            &service,
            json!({"operation":"update","url":"https://a.example/","newUrl":"https://a.example/","expectedName":"😀".repeat(80),"name":"two"}),
        );
        let (one, two) = tokio::join!(one, two);
        assert_ne!(one.is_ok(), two.is_ok());
        assert_eq!(read(&service, "a").await.unwrap().items.len(), 1);
        pool.close().await;
    }

    #[tokio::test]
    async fn concurrent_operations_persist_and_do_not_touch_other_accounts_or_config() {
        let directory =
            std::env::temp_dir().join(format!("reader-subscriptions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let database = format!(
            "sqlite:{}",
            directory
                .join("test.sqlite")
                .to_string_lossy()
                .replace('\\', "/")
        );
        let pool = init_pool(&database).await.unwrap();
        let service = JsonDocumentService::new(pool.clone(), directory.to_str().unwrap());
        service
            .set_value(
                "account-a",
                "userConfig",
                &serde_json::json!({"sentinel": "keep"}),
            )
            .await
            .unwrap();
        let first = apply(
            &service,
            "account-a",
            SubscriptionOperation::Add {
                name: None,
                url: " https://one.example/?private=keep ".into(),
            },
        );
        let second = apply(
            &service,
            "account-a",
            SubscriptionOperation::Add {
                name: None,
                url: "https://two.example/".into(),
            },
        );
        let (first, second) = tokio::join!(first, second);
        first.unwrap();
        second.unwrap();
        let doc = read(&service, "account-a").await.unwrap();
        assert_eq!(doc.items.len(), 2);
        assert!(doc.items.iter().all(|item| item.last_synced_at.is_none()));
        assert_eq!(doc.revision, 2);
        assert!(read(&service, "account-b").await.unwrap().items.is_empty());
        let (remove, add) = tokio::join!(
            apply(
                &service,
                "account-a",
                SubscriptionOperation::Remove {
                    url: "https://two.example/".into()
                }
            ),
            apply(
                &service,
                "account-a",
                SubscriptionOperation::Add {
                    name: None,
                    url: "https://three.example/".into()
                }
            )
        );
        remove.unwrap();
        add.unwrap();
        apply(
            &service,
            "account-a",
            SubscriptionOperation::Add {
                name: None,
                url: "https://three.example/".into(),
            },
        )
        .await
        .unwrap();
        let final_doc = read(&service, "account-a").await.unwrap();
        assert_eq!(final_doc.items.len(), 2);
        assert!(final_doc
            .items
            .iter()
            .any(|item| item.url == "https://one.example/?private=keep"));
        assert_eq!(
            service
                .get_value("account-a", "userConfig")
                .await
                .unwrap()
                .unwrap()["sentinel"],
            "keep"
        );
        pool.close().await;
        let reopened_pool = init_pool(&database).await.unwrap();
        let reopened = JsonDocumentService::new(reopened_pool.clone(), directory.to_str().unwrap());
        assert_eq!(read(&reopened, "account-a").await.unwrap(), final_doc);
        reopened_pool.close().await;
        drop(reopened);
        drop(service);
        // Windows can release SQLite handles shortly after pool.close completes.
        // Keep cleanup mandatory; retry only the transient sharing violation.
        for attempt in 0..20 {
            match std::fs::remove_dir_all(&directory) {
                Ok(()) => break,
                Err(error) if cfg!(windows) && error.raw_os_error() == Some(32) && attempt < 19 => {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                Err(error) => panic!("temporary SQLite cleanup failed: {error}"),
            }
        }
    }

    #[tokio::test]
    async fn migration_preserves_times_and_invalid_batch_writes_nothing() {
        let pool = init_pool("sqlite::memory:").await.unwrap();
        let service = JsonDocumentService::new(pool.clone(), "unused");
        let migrated = apply(
            &service,
            "a",
            SubscriptionOperation::Migrate {
                items: vec![
                    SourceSubscription {
                        name: None,
                        url: "https://one.example/?key=original".into(),
                        last_synced_at: Some(1000),
                    },
                    SourceSubscription {
                        name: None,
                        url: "https://one.example/?key=original".into(),
                        last_synced_at: Some(2000),
                    },
                ],
            },
        )
        .await
        .unwrap();
        assert_eq!(migrated.items.len(), 1);
        assert_eq!(migrated.items[0].last_synced_at, Some(2000));
        let synced = apply(
            &service,
            "a",
            SubscriptionOperation::Synced {
                name: None,
                existing_only: false,
                url: migrated.items[0].url.clone(),
            },
        )
        .await
        .unwrap();
        let again = apply(
            &service,
            "a",
            SubscriptionOperation::Migrate {
                items: migrated.items.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(synced, again);
        assert!(apply(
            &service,
            "a",
            SubscriptionOperation::Migrate {
                items: vec![
                    SourceSubscription {
                        name: None,
                        url: "https://valid.example/".into(),
                        last_synced_at: None
                    },
                    SourceSubscription {
                        name: None,
                        url: "not-a-link".into(),
                        last_synced_at: None
                    },
                ]
            }
        )
        .await
        .is_err());
        assert_eq!(read(&service, "a").await.unwrap(), again);
        pool.close().await;
    }
}
