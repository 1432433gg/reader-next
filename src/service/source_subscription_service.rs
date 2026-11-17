use crate::{error::error::AppError, service::json_document_service::JsonDocumentService};
use serde::{Deserialize, Serialize};

const DOCUMENT: &str = "source-subscriptions-v1";
const MAX_ITEMS: usize = 5000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSubscription {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SubscriptionDocument {
    pub revision: u64,
    pub items: Vec<SourceSubscription>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub enum SubscriptionOperation {
    Add { url: String },
    Remove { url: String },
    Synced { url: String },
    Migrate { items: Vec<SourceSubscription> },
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
    // Preserve spelling and query parameters; URL parsing is validation only.
    Ok(value.to_owned())
}

pub async fn read(
    service: &JsonDocumentService,
    namespace: &str,
) -> Result<SubscriptionDocument, AppError> {
    decode(service.get_raw(namespace, DOCUMENT).await?.as_deref())
}

fn decode(raw: Option<&str>) -> Result<SubscriptionDocument, AppError> {
    raw.map(serde_json::from_str)
        .transpose()
        .map(|doc| doc.unwrap_or_default())
        .map_err(|_| AppError::Internal(anyhow::anyhow!("invalid subscription document")))
}

pub async fn apply(
    service: &JsonDocumentService,
    namespace: &str,
    operation: SubscriptionOperation,
) -> Result<SubscriptionDocument, AppError> {
    let now = chrono::Utc::now().timestamp_millis();
    // Validate the whole operation before any write. Error messages omit URLs.
    let operation = match operation {
        SubscriptionOperation::Add { url } => SubscriptionOperation::Add {
            url: clean_url(&url)?,
        },
        SubscriptionOperation::Remove { url } => SubscriptionOperation::Remove {
            url: clean_url(&url)?,
        },
        SubscriptionOperation::Synced { url } => SubscriptionOperation::Synced {
            url: clean_url(&url)?,
        },
        SubscriptionOperation::Migrate { items } => {
            if items.len() > MAX_ITEMS {
                return Err(AppError::BadRequest("本机订阅过多".into()));
            }
            let items = items
                .into_iter()
                .map(|item| {
                    Ok(SourceSubscription {
                        url: clean_url(&item.url)?,
                        last_synced_at: item
                            .last_synced_at
                            .filter(|time| *time > 0 && *time <= now),
                    })
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            SubscriptionOperation::Migrate { items }
        }
    };
    for _ in 0..12 {
        let raw = service.get_raw(namespace, DOCUMENT).await?;
        let mut doc = decode(raw.as_deref())?;
        let previous = doc.items.clone();
        match &operation {
            SubscriptionOperation::Remove { url } => doc.items.retain(|item| &item.url != url),
            SubscriptionOperation::Add { url } | SubscriptionOperation::Synced { url } => {
                if !doc.items.iter().any(|item| &item.url == url) {
                    doc.items.push(SourceSubscription {
                        url: url.clone(),
                        last_synced_at: None,
                    });
                }
                if matches!(&operation, SubscriptionOperation::Synced { .. }) {
                    let item = doc.items.iter_mut().find(|item| &item.url == url).unwrap();
                    item.last_synced_at = Some(item.last_synced_at.unwrap_or(0).max(now));
                }
            }
            SubscriptionOperation::Migrate { items } => {
                for incoming in items {
                    if let Some(existing) =
                        doc.items.iter_mut().find(|item| item.url == incoming.url)
                    {
                        existing.last_synced_at =
                            existing.last_synced_at.max(incoming.last_synced_at);
                    } else {
                        doc.items.push(incoming.clone());
                    }
                }
            }
        }
        if doc.items.len() > MAX_ITEMS {
            return Err(AppError::BadRequest("订阅数量已达上限".into()));
        }
        if doc.items == previous {
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
                url: " https://one.example/?private=keep ".into(),
            },
        );
        let second = apply(
            &service,
            "account-a",
            SubscriptionOperation::Add {
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
        std::fs::remove_dir_all(directory).unwrap();
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
                        url: "https://one.example/?key=original".into(),
                        last_synced_at: Some(1000),
                    },
                    SourceSubscription {
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
                        url: "https://valid.example/".into(),
                        last_synced_at: None
                    },
                    SourceSubscription {
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
