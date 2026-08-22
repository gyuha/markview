use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// 드롭·열기로 받아들일 최대 파일 크기. 프론트엔드 파싱이라 이보다 크면 메인 스레드가 막힌다.
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const ALLOWED_EXT: [&str; 4] = ["md", "markdown", "mdown", "mkd"];

/// OS가 파일 연결로 넘긴 경로를 모아두는 버퍼.
/// `Opened` 이벤트는 프론트엔드가 리스너를 달기 전에 도착할 수 있으므로,
/// 이벤트를 직접 소비하지 않고 여기에 쌓아 프론트엔드가 가져가게 한다 — 버퍼가 단일 출처다.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

/// 버퍼를 비우며 돌려준다. 비우기 때문에 시작 시 조회와 이벤트 후 조회가 중복되지 않는다.
#[tauri::command]
fn take_pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[derive(serde::Serialize)]
struct Document {
    path: String,
    text: String,
}

/// 마크다운 파일을 읽어 문자열로 돌려준다.
/// plugin-fs의 넓은 scope를 여는 대신 이 커맨드 하나만 노출하고, 검증을 여기서 전부 한다.
#[tauri::command]
fn read_markdown(app: AppHandle, path: String) -> Result<Document, String> {
    let p = PathBuf::from(&path);

    if p.is_dir() {
        return Err("폴더는 열 수 없습니다. 마크다운 파일을 지정하세요.".into());
    }
    if !p.is_file() {
        return Err(format!("파일을 찾을 수 없습니다: {path}"));
    }

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(format!(
            "지원하지 않는 확장자입니다: .{ext} (허용: .md, .markdown, .mdown, .mkd)"
        ));
    }

    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "파일이 너무 큽니다: {:.1}MB (상한 5MB)",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }

    let text = std::fs::read_to_string(&p).map_err(|e| format!("읽을 수 없습니다: {e}"))?;

    // 문서 안의 상대 경로 이미지를 asset protocol로 로드하려면 그 문서의 부모 디렉터리만 허용한다.
    if let Some(dir) = p.parent() {
        app.asset_protocol_scope()
            .allow_directory(dir, false)
            .map_err(|e| format!("이미지 경로를 허용할 수 없습니다: {e}"))?;
    }

    Ok(Document {
        path: p.to_string_lossy().to_string(),
        text,
    })
}

/// 메뉴를 직접 조립한다.
/// predefined `close_window`의 가속기는 ⌘W로 고정이고 macOS는 메뉴 키 등가물을
/// responder chain보다 먼저 처리하므로, 그 항목을 두는 한 webview는 ⌘W를 볼 수 없다.
/// 그래서 predefined close_window를 어느 메뉴에도 넣지 않고 커스텀 항목 두 개로 대체한다.
fn build_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = Submenu::with_items(
        handle,
        "markview",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(handle, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(
                handle,
                "close-window",
                "Close Window",
                true,
                Some("Shift+CmdOrCtrl+W"),
            )?,
        ],
    )?;

    // 복사·전체선택이 빠지면 문서 텍스트를 복사할 수 없게 되므로 반드시 유지한다.
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
        ],
    )?;

    Menu::with_items(
        handle,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 창 크기·위치·최대화 상태를 종료 시 저장하고 다음 실행에 복원한다.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .menu(|handle| build_menu(handle))
        .on_menu_event(|handle, event| {
            // 메뉴는 창 개수를 알지만 탭 개수는 모른다 — 탭 판단은 프론트엔드에 맡긴다.
            match event.id().as_ref() {
                "close-tab" => {
                    let _ = handle.emit("close-tab", ());
                }
                "close-window" => {
                    let _ = handle.emit("close-window", ());
                }
                _ => {}
            }
        })
        .manage(PendingFiles::default())
        .invoke_handler(tauri::generate_handler![read_markdown, take_pending_files])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // macOS가 "연결 프로그램으로 열기"나 파일 더블클릭으로 앱을 깨울 때 오는 이벤트.
        if let RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if paths.is_empty() {
                return;
            }
            if let Some(state) = handle.try_state::<PendingFiles>() {
                state.0.lock().unwrap().extend(paths);
            }
            // 프론트엔드가 이미 살아 있으면 지금 가져가라고 알린다. 아직이면 시작 시 버퍼를 비운다.
            let _ = handle.emit("files-opened", ());
        }
    });
}
