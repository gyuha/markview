//! 앱 안 업데이트. 확인·내려받기·설치는 전부 Rust가 한다 — 웹뷰에는 커맨드 `check_update`·`install_update`와
//! 이벤트 `update-progress`만 열고 updater/process/dialog 권한은 주지 않는다(ADR 261010-234732).
//! 내려받은 파일의 서명은 플러그인이 `tauri.conf.json`의 공개 키로 검증한다 — 맞지 않으면 설치되지 않는다.
//!
//! 웹뷰가 임의로 설치를 시작하지 못하도록 `install_update`는 **직전 `check_update`가 찾은 업데이트만** 설치한다.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 화면에 넘기는 새 버전 정보.
#[derive(Serialize, Debug, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub date: Option<String>,
}

impl UpdateInfo {
    fn of(update: &Update) -> Self {
        UpdateInfo {
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
            date: update.date.map(|d| d.to_string()),
        }
    }
}

/// `update-progress` 이벤트의 값. 총량을 모르면(`total: None`) 화면이 퍼센트 대신 받은 양만 보인다.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// 받은 양을 한 조각만큼 늘린다. 서버가 알려 준 총량보다 많이 받았다고 보고하는 일은 없게 자른다.
pub fn advance(downloaded: u64, chunk: usize, total: Option<u64>) -> Progress {
    let next = downloaded.saturating_add(chunk as u64);
    Progress {
        downloaded: total.map_or(next, |t| next.min(t)),
        total,
    }
}

/// 직전 확인이 찾은 업데이트 한 개를 보관한다. 설치하면 비워서 같은 업데이트를 두 번 설치하지 못하게 한다.
pub struct Pending<T>(Mutex<Option<T>>);

impl<T> Default for Pending<T> {
    fn default() -> Self {
        Pending(Mutex::new(None))
    }
}

impl<T> Pending<T> {
    /// 새로 찾은 것으로 바꾼다(가장 최근 확인이 이긴다).
    pub fn store(&self, value: Option<T>) {
        *self.0.lock().unwrap() = value;
    }

    /// 설치하려고 꺼낸다. 확인된 업데이트가 없으면 거부한다.
    pub fn take(&self) -> Result<T, String> {
        self.0
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "확인된 업데이트가 없습니다. 먼저 업데이트를 확인하세요.".to_string())
    }
}

pub type PendingUpdate = Pending<Update>;

/// 새 버전이 있는지 GitHub 릴리스의 latest.json으로 확인한다. 없으면 `None`.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = found.as_ref().map(UpdateInfo::of);
    pending.store(found);
    Ok(info)
}

/// 확인된 업데이트를 내려받아 설치하고 앱을 다시 시작한다. 진행은 `update-progress` 이벤트로 알린다.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.take()?;
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                let progress = advance(downloaded, chunk, total);
                downloaded = progress.downloaded;
                let _ = app.emit("update-progress", progress);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 확인된_업데이트가_없으면_설치_요청을_거부한다() {
        let pending: Pending<u32> = Pending::default();
        assert!(pending.take().unwrap_err().contains("먼저 업데이트를 확인"));
        // 확인했는데 새 버전이 없었다면 이전에 찾은 것도 지워져서 거부된다.
        pending.store(Some(1));
        pending.store(None);
        assert!(pending.take().is_err());
    }

    #[test]
    fn 설치하면_보관한_업데이트가_비워져_두_번_설치되지_않는다() {
        let pending = Pending::default();
        pending.store(Some("0.4.0"));
        assert_eq!(pending.take().unwrap(), "0.4.0");
        assert!(pending.take().is_err());
        // 가장 최근 확인이 이긴다.
        pending.store(Some("0.4.0"));
        pending.store(Some("0.4.1"));
        assert_eq!(pending.take().unwrap(), "0.4.1");
    }

    #[test]
    fn 진행률은_총량을_모를_때도_안전하고_총량을_넘지_않는다() {
        let a = advance(0, 400, Some(1000));
        assert_eq!(a, Progress { downloaded: 400, total: Some(1000) });
        // 총량을 넘게 보고된 마지막 조각은 총량으로 자른다 — 화면이 100%를 넘지 않는다.
        assert_eq!(advance(900, 400, Some(1000)).downloaded, 1000);
        // 총량을 모르면 받은 양만 늘린다.
        assert_eq!(advance(10, 5, None), Progress { downloaded: 15, total: None });
        // 아주 큰 값에서도 넘치지 않는다.
        assert_eq!(advance(u64::MAX, 5, None).downloaded, u64::MAX);
    }

    #[test]
    fn 웹뷰로_나가는_값의_모양이_화면_약속과_같다() {
        let info = UpdateInfo { version: "9.9.9".into(), notes: "노트".into(), date: None };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({ "version": "9.9.9", "notes": "노트", "date": null })
        );
        assert_eq!(
            serde_json::to_value(Progress { downloaded: 5, total: None }).unwrap(),
            serde_json::json!({ "downloaded": 5, "total": null })
        );
    }
}
