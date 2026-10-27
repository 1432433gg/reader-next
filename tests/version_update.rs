use reader_next::service::update_service::{
    build_update_info, cache_needs_refresh, is_newer_version, GithubRelease, UpdatePreferences,
};

#[test]
fn compares_release_tags_as_semver_versions() {
    assert!(is_newer_version("v1.0.6", "v1.0.5"));
    assert!(is_newer_version("1.10.0", "v1.9.9"));
    assert!(!is_newer_version("v1.0.5", "1.0.5"));
    assert!(!is_newer_version("v1.0.4", "v1.0.5"));
}

#[test]
fn dismissed_latest_release_remains_update_without_reminder() {
    let release = GithubRelease {
        tag_name: "v1.0.6".to_string(),
        name: Some("v1.0.6".to_string()),
        html_url: "https://github.com/Maple0517/reader-next/releases/tag/v1.0.6".to_string(),
        published_at: Some("2026-05-15T08:00:00Z".to_string()),
    };
    let preferences = UpdatePreferences {
        dismissed_version: Some("v1.0.6".to_string()),
    };

    let info = build_update_info(
        "v1.0.5",
        Some(release),
        Some(preferences),
        None,
        1_778_828_800,
    );

    assert!(info.update_available);
    assert!(!info.should_remind);
    assert_eq!(info.latest_version.as_deref(), Some("v1.0.6"));
    assert_eq!(info.dismissed_version.as_deref(), Some("v1.0.6"));
}

#[test]
fn refreshes_cache_when_server_is_newer_than_cached_release() {
    let now = 1_778_828_800_000;
    let fresh = now - 60_000;
    let expired = now - 7 * 60 * 60 * 1000;

    // 缓存没过期，但里面的「最新版」比当前服务端还旧：服务端刚升级过，要重新拉
    assert!(cache_needs_refresh("1.1.0", Some("v1.0.3"), fresh, now));
    // 缓存没过期，版本不比服务端旧：不用拉
    assert!(!cache_needs_refresh("1.1.0", Some("v1.1.0"), fresh, now));
    assert!(!cache_needs_refresh("1.0.9", Some("v1.1.0"), fresh, now));
    assert!(!cache_needs_refresh("1.1.0", None, fresh, now));
    // 过期或从没检查过：照常拉
    assert!(cache_needs_refresh("1.1.0", Some("v1.1.0"), expired, now));
    assert!(cache_needs_refresh("1.1.0", None, 0, now));
}
