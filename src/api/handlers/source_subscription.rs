use crate::{
    api::{auth::AuthContext, AppState},
    error::error::{ApiResponse, AppError},
    service::source_subscription_service::{self, SubscriptionDocument, SubscriptionOperation},
};
use axum::{extract::State, Json};

async fn account(state: &AppState, auth: &AuthContext) -> Result<String, AppError> {
    let token = auth
        .access_token()
        .ok_or_else(|| AppError::BadRequest("NEED_LOGIN".into()))?;
    let user = state
        .user_service
        .check_auth(token)
        .await?
        .ok_or_else(|| AppError::BadRequest("NEED_LOGIN".into()))?;
    if auth
        .user_ns()
        .is_some_and(|namespace| namespace != user.username)
    {
        return Err(AppError::BadRequest("不允许指定其他账号".into()));
    }
    Ok(user.username)
}

pub async fn get_source_subscriptions(
    State(state): State<AppState>,
    auth: AuthContext,
) -> Result<Json<ApiResponse<SubscriptionDocument>>, AppError> {
    let namespace = account(&state, &auth).await?;
    Ok(Json(ApiResponse::ok(
        source_subscription_service::read(&state.json_document_service, &namespace).await?,
    )))
}

pub async fn change_source_subscriptions(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(operation): Json<SubscriptionOperation>,
) -> Result<Json<ApiResponse<SubscriptionDocument>>, AppError> {
    let namespace = account(&state, &auth).await?;
    Ok(Json(ApiResponse::ok(
        source_subscription_service::apply(&state.json_document_service, &namespace, operation)
            .await?,
    )))
}
