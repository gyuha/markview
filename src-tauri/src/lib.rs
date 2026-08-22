use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 드롭·열기로 받아들일 최대 파일 크기. 프론트엔드 파싱이라 이보다 크면 메인 스레드가 막힌다.
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const ALLOWED_EXT: [&str; 4] = ["md", "markdown", "mdown", "mkd"];

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![read_markdown])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
