use axum::{extract::State, Json};
use serde_json::Value;

use crate::api::auth::AuthContext;
use crate::api::AppState;
use crate::error::error::{ApiResponse, AppError};

async fn resolve_ns(state: &AppState, auth: &AuthContext) -> Result<String, AppError> {
    state
        .user_service
        .resolve_user_ns_with_override(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await
        .map_err(|_| AppError::BadRequest("NEED_LOGIN".to_string()))
}

/// 自动检查新章节的状态：开关、间隔、上次/下次检查时间、上次结果
pub async fn get_chapter_update_status(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_ns(&state, &auth).await?;
    let status = state.chapter_update_service.status(&user_ns).await;
    Ok(Json(ApiResponse::ok(
        serde_json::to_value(status).unwrap_or_default(),
    )))
}

/// 立即在后台检查当前用户书架的新章节；用 getChapterUpdateStatus 轮询结果
pub async fn check_chapter_updates(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<Value>>, AppError> {
    let user_ns = resolve_ns(&state, &auth).await?;
    let started = state.chapter_update_service.start_user_check(user_ns);
    Ok(Json(ApiResponse::ok(
        serde_json::json!({ "started": started }),
    )))
}
