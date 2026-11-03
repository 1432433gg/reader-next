use crate::api::{auth::AuthContext, AppState};
use crate::error::error::{ApiResponse, AppError};
use crate::model::book::Book;
use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use image::{ImageFormat, ImageReader};
use serde::Deserialize;
use std::io::Cursor;
use tokio::fs;
use uuid::Uuid;

const MAX_COVER_BYTES: usize = 5 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCoverRequest {
    book_url: String,
}

// Decode and re-encode instead of trusting a filename/MIME header. Also removes metadata.
fn normalize_cover(bytes: Vec<u8>) -> Result<Vec<u8>, AppError> {
    let bad_image =
        || AppError::BadRequest("请选择有效的 JPG、PNG 或 WebP 图片（最大 5MB）".into());
    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES {
        return Err(bad_image());
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| bad_image())?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP)
    ) {
        return Err(bad_image());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| bad_image())?;
    let scaled = if decoded.width() > 600 || decoded.height() > 900 {
        decoded.thumbnail(600, 900)
    } else {
        decoded
    };
    let rgba = scaled.to_rgba8();
    // Flatten transparency on white, rather than producing black backgrounds in JPEG.
    let rgb = image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let p = rgba.get_pixel(x, y).0;
        let alpha = u32::from(p[3]);
        image::Rgb(
            [0, 1, 2].map(|c| ((u32::from(p[c]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8),
        )
    });
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 85)
        .encode_image(&rgb)
        .map_err(|_| bad_image())?;
    Ok(output)
}

pub async fn upload_book_cover(
    State(state): State<AppState>,
    auth: AuthContext,
    Query(req): Query<BookCoverRequest>,
    mut multipart: Multipart,
) -> Result<Json<ApiResponse<Book>>, AppError> {
    let user_ns = state
        .user_service
        .resolve_user_ns_with_override(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await?;
    if state
        .book_service
        .get_shelf_book(&user_ns, &req.book_url)
        .await?
        .is_none()
    {
        return Err(AppError::BadRequest("请先将书籍加入书架".into()));
    }
    let mut image_bytes = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::BadRequest("图片上传失败".into()))?
    {
        if field.name() != Some("file") || image_bytes.is_some() {
            return Err(AppError::BadRequest("请选择一张封面图片".into()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|_| AppError::BadRequest("图片上传失败，最大支持 5MB".into()))?
        {
            if bytes.len() + chunk.len() > MAX_COVER_BYTES {
                return Err(AppError::BadRequest("封面图片不能超过 5MB".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        image_bytes = Some(bytes);
    }
    let bytes = image_bytes.ok_or_else(|| AppError::BadRequest("请选择封面图片".into()))?;
    let image = tokio::task::spawn_blocking(move || normalize_cover(bytes))
        .await
        .map_err(|e| AppError::Internal(e.into()))??;
    let id = Uuid::new_v4().to_string();
    let dir = std::path::Path::new(&state.config.storage_dir).join("book-covers");
    fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    let path = dir.join(format!("{id}.jpg"));
    fs::write(&path, image)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    match state
        .book_service
        .set_custom_cover(
            &user_ns,
            &req.book_url,
            Some(format!("/reader3/bookCover/{id}")),
        )
        .await
    {
        Ok(book) => Ok(Json(ApiResponse::ok(book))),
        Err(err) => {
            let _ = fs::remove_file(path).await;
            Err(err)
        }
    }
}

pub async fn reset_book_cover(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(req): Json<BookCoverRequest>,
) -> Result<Json<ApiResponse<Book>>, AppError> {
    let user_ns = state
        .user_service
        .resolve_user_ns_with_override(auth.access_token(), auth.secure_key(), auth.user_ns())
        .await?;
    let book = state
        .book_service
        .set_custom_cover(&user_ns, &req.book_url, None)
        .await?;
    Ok(Json(ApiResponse::ok(book)))
}

// Like source covers, these are readable by image elements without auth headers.
// A random UUID acts as an opaque URL; uploads/mutations still require the book owner.
// Keep old images for existing backups and other devices holding an older shelf snapshot.
pub async fn get_custom_book_cover(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    let Ok(uuid) = Uuid::parse_str(&id) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    if uuid.to_string() != id {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let path = std::path::Path::new(&state.config.storage_dir)
        .join("book-covers")
        .join(format!("{id}.jpg"));
    match fs::read(path).await {
        Ok(bytes) => Ok((
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            Body::from(bytes),
        )
            .into_response()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(StatusCode::NOT_FOUND.into_response())
        }
        Err(err) => Err(AppError::Internal(err.into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_fake_unsupported_and_oversized_images() {
        assert!(normalize_cover(b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec()).is_err());
        assert!(normalize_cover(b"\x89PNG\r\n\x1a\ninvalid".to_vec()).is_err());
        assert!(normalize_cover(vec![0; MAX_COVER_BYTES + 1]).is_err());
    }

    #[test]
    fn shrinks_images_without_stretching_and_flattens_transparency() {
        let img = image::RgbaImage::from_pixel(1200, 2400, image::Rgba([0, 0, 0, 0]));
        let mut png = Cursor::new(Vec::new());
        img.write_to(&mut png, ImageFormat::Png).unwrap();
        let output = normalize_cover(png.into_inner()).unwrap();
        let decoded = image::load_from_memory(&output).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (450, 900));
        assert!(decoded.get_pixel(0, 0).0.iter().all(|v| *v > 250));
        // Every advertised input format must be decoded, not merely MIME-sniffed.
        let tiny = image::RgbImage::from_pixel(2, 3, image::Rgb([20, 100, 200]));
        for format in [ImageFormat::Jpeg, ImageFormat::Png, ImageFormat::WebP] {
            let mut encoded = Cursor::new(Vec::new());
            tiny.write_to(&mut encoded, format).unwrap();
            let normalized = normalize_cover(encoded.into_inner()).unwrap();
            let decoded = image::load_from_memory(&normalized).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (2, 3));
        }
    }
}
