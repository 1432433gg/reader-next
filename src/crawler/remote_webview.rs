use crate::crawler::{
    fetcher::{FetchResponse, HttpMethod, RequestSpec},
    url_analyzer::webview_link,
};
use crate::error::error::AppError;
use crate::util::{
    hash::md5_hex,
    text::{normalize_source_url, repair_encoded_url},
    time::now_ts,
};
use anyhow::{anyhow, ensure};
use reqwest::{header, Client, StatusCode};
use serde::Serialize;
use sqlx::SqlitePool;
use std::{collections::BTreeMap, time::Duration};
use url::Url;

#[derive(Clone)]
pub struct RemoteWebView {
    endpoint: Url,
    client: Client,
    pool: SqlitePool,
}

#[derive(Clone, Copy)]
pub enum LinkRole {
    Book,
    Catalog,
    Chapter,
}

impl LinkRole {
    fn key(self, source: &str, url: &str) -> String {
        let scope = match self {
            Self::Book => "book",
            Self::Catalog => "catalog",
            Self::Chapter => "chapter",
        };
        let key = format!(
            "{}\0{}",
            normalize_source_url(source),
            repair_encoded_url(url)
        );
        format!("webview-request-{scope}-{}", md5_hex(&key))
    }
}

#[derive(Serialize)]
struct RenderRequest<'a> {
    url: &'a str,
    http_method: &'a HttpMethod,
    headers: BTreeMap<String, &'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    js_source: Option<&'a str>,
    wait_ms: u64,
}

impl RemoteWebView {
    pub fn new(base_url: &str, timeout: Duration, pool: SqlitePool) -> anyhow::Result<Self> {
        let mut endpoint = http_url(base_url)
            .ok_or_else(|| anyhow!("REMOTE_WEBVIEW_URL must be an HTTP(S) service URL"))?;
        ensure!(
            endpoint.query().is_none() && endpoint.fragment().is_none(),
            "REMOTE_WEBVIEW_URL must not contain a query or fragment"
        );
        let path = endpoint.path().trim_end_matches('/').to_owned();
        if path.ends_with("/render.html") {
            endpoint.set_path(&path);
        } else {
            endpoint.set_path(&format!("{path}/render.html"));
        }
        let client = Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?;
        Ok(Self {
            endpoint,
            client,
            pool,
        })
    }

    pub async fn fetch(&self, req: &RequestSpec) -> anyhow::Result<FetchResponse> {
        let mut headers = req
            .headers
            .iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value.as_str()))
            .collect::<BTreeMap<_, _>>();
        let body = if req.method == HttpMethod::POST {
            req.body.as_deref()
        } else {
            None
        };
        if body.is_some() {
            headers
                .entry("content-type".to_string())
                .or_insert("application/x-www-form-urlencoded");
        }
        let payload = RenderRequest {
            url: &req.url,
            http_method: &req.method,
            headers,
            body,
            js_source: req.web_js.as_deref(),
            wait_ms: req.web_view_delay_time,
        };
        let response = self
            .client
            .post(self.endpoint.clone())
            .json(&payload)
            .send()
            .await
            .map_err(|e| anyhow!("WebView service request failed: {}", e.without_url()))?;
        ensure!(
            response.status().is_success(),
            "WebView service returned HTTP {}",
            response.status().as_u16()
        );
        let headers = response.headers();
        let final_url = match headers.get("x-webview-final-url") {
            Some(value) => {
                let decoded = urlencoding::decode(value.to_str()?)?;
                http_url(&decoded)
                    .ok_or_else(|| anyhow!("WebView service returned an invalid final URL"))?
                    .to_string()
            }
            None => req.url.clone(),
        };
        let status = match headers.get("x-webview-status") {
            Some(value) => StatusCode::from_u16(value.to_str()?.parse()?)?,
            None => response.status(),
        };
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response
            .text()
            .await
            .map_err(|e| anyhow!("WebView service response failed: {}", e.without_url()))?;
        ensure!(
            !body.trim().is_empty(),
            "WebView service returned an empty document"
        );
        Ok(FetchResponse {
            url: final_url,
            status: status.as_u16(),
            is_successful: status.is_success(),
            body,
            content_type,
            headers: Vec::new(),
        })
    }

    pub async fn remember_request(
        &self,
        user: &str,
        source: &str,
        role: LinkRole,
        link: &str,
    ) -> Result<Option<String>, AppError> {
        let mut ids = self.remember_requests(user, source, role, &[link]).await?;
        Ok(ids.pop().flatten())
    }

    pub async fn remember_requests(
        &self,
        user: &str,
        source: &str,
        role: LinkRole,
        links: &[&str],
    ) -> Result<Vec<Option<String>>, AppError> {
        let mut ids = Vec::new();
        let mut transaction = None;
        for link in links {
            let Some((url, options)) = webview_link(link) else {
                ids.push(None);
                continue;
            };
            let scope = role.key(source, url);
            let id = md5_hex(&format!("{scope}\0{options}"));
            let name = format!("{scope}-{id}");
            let json =
                serde_json::to_string(options).map_err(|err| AppError::Internal(err.into()))?;
            if transaction.is_none() {
                transaction = Some(self.pool.begin().await?);
            }
            sqlx::query(
                "INSERT INTO json_documents (namespace, name, json, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(namespace, name) DO NOTHING",
            )
            .bind(user)
            .bind(name)
            .bind(json)
            .bind(now_ts() * 1000)
            .execute(&mut **transaction.as_mut().expect("transaction opened for marked link"))
            .await?;
            ids.push(Some(id));
        }
        if let Some(transaction) = transaction {
            transaction.commit().await?;
        }
        Ok(ids)
    }

    pub async fn remember_book_catalog(
        &self,
        user: &str,
        source: &str,
        book_url: &str,
        book_id: &str,
        toc_url: &str,
        toc_id: Option<&str>,
    ) -> Result<(), AppError> {
        let name = book_catalog_key(source, book_url, book_id);
        let json =
            serde_json::to_string(&(toc_url, toc_id)).map_err(|e| AppError::Internal(e.into()))?;
        sqlx::query(
            "INSERT INTO json_documents (namespace, name, json, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(namespace, name) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at
             WHERE json_documents.json <> excluded.json",
        ).bind(user).bind(name).bind(json).bind(now_ts() * 1000)
        .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn book_catalog(
        &self,
        user: &str,
        source: &str,
        book_url: &str,
        book_id: &str,
    ) -> Result<Option<(String, Option<String>)>, AppError> {
        let json: Option<String> =
            sqlx::query_scalar("SELECT json FROM json_documents WHERE namespace=?1 AND name=?2")
                .bind(user)
                .bind(book_catalog_key(source, book_url, book_id))
                .fetch_optional(&self.pool)
                .await?;
        json.map(|value| serde_json::from_str(&value).map_err(|err| AppError::Internal(err.into())))
            .transpose()
    }

    pub async fn request_by_id(
        &self,
        user: &str,
        source: &str,
        role: LinkRole,
        url: &str,
        id: &str,
    ) -> Result<String, AppError> {
        let name = format!("{}-{id}", role.key(source, url));
        let json: Option<String> =
            sqlx::query_scalar("SELECT json FROM json_documents WHERE namespace=?1 AND name=?2")
                .bind(user)
                .bind(name)
                .fetch_optional(&self.pool)
                .await?;
        let json = json.ok_or_else(|| {
            AppError::BadRequest("书源请求选项不存在，请重新搜索或刷新详情".to_owned())
        })?;
        let options: String =
            serde_json::from_str(&json).map_err(|err| AppError::Internal(err.into()))?;
        Ok(format!("{url},{options}"))
    }
}

fn book_catalog_key(source: &str, book_url: &str, book_id: &str) -> String {
    format!(
        "{}-{book_id}-resolved-catalog",
        LinkRole::Book.key(source, book_url)
    )
}

fn http_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_chapter_request_survives_a_plain_catalog_and_is_bound_to_its_scope() {
        let pool = crate::storage::db::init_pool("sqlite::memory:")
            .await
            .unwrap();
        let webview =
            RemoteWebView::new("http://webview:8050", Duration::from_secs(15), pool).unwrap();
        let source = "https://source.example";
        let url = "https://site.example/chapter";
        let marked = format!(r#"{url},{{"webView":true}}"#);
        let ids = webview
            .remember_requests("alice", source, LinkRole::Chapter, &[marked.as_str(), url])
            .await
            .unwrap();
        assert!(ids[1].is_none());
        let id = ids[0].as_deref().unwrap();
        assert_eq!(
            webview
                .request_by_id("alice", source, LinkRole::Chapter, url, id)
                .await
                .unwrap(),
            marked
        );
        for (user, source, role, url) in [
            ("bob", source, LinkRole::Chapter, url),
            ("alice", "https://other.example", LinkRole::Chapter, url),
            ("alice", source, LinkRole::Catalog, url),
            (
                "alice",
                source,
                LinkRole::Chapter,
                "https://site.example/different",
            ),
        ] {
            assert!(webview
                .request_by_id(user, source, role, url, id)
                .await
                .is_err());
        }
    }
}
