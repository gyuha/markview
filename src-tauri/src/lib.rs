mod assets;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// 이 세션에서 실제로 읽은 문서 경로. 쓰기는 이 목록에 있는 경로만 허용한다.
/// raw HTML을 허용했으므로(ADR 260822-222214) 임의 경로 쓰기를 IPC에 올리면
/// 악성 문서의 XSS가 아무 파일이나 덮어쓸 수 있다.
#[derive(Default)]
struct OpenedPaths(Mutex<HashSet<PathBuf>>);

/// 창 닫기를 한 번 통과시키는 플래그.
/// 닫기 요청을 막고 프론트엔드에 확인을 넘기면, 확인을 마친 프론트엔드가 다시 close()를 부르는데
/// 그것도 같은 이벤트를 일으켜 무한히 막히게 된다. 이 플래그가 두 번째 요청을 통과시킨다.
/// (destroy()로 우회하면 더 짧지만 창 상태 저장을 건너뛸 수 있어 택하지 않았다.)
#[derive(Default)]
struct CloseGuard(AtomicBool);

/// 프론트엔드가 "닫아도 된다"고 알리는 커맨드. 다음 닫기 요청 한 번을 통과시킨다.
#[tauri::command]
fn allow_close(guard: tauri::State<CloseGuard>) {
    guard.0.store(true, Ordering::SeqCst);
}

#[derive(serde::Serialize)]
struct Document {
    path: String,
    text: String,
    /// 저장 직전에 외부 변경을 감지하기 위한 수정 시각(밀리초). 읽을 수 없으면 0.
    mtime_ms: u64,
}

/// 파일의 수정 시각을 밀리초로. 비교용이므로 읽지 못하면 0을 준다(그 경우 비교를 건너뛴다).
fn mtime_ms(path: &PathBuf) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 마크다운 파일을 읽어 문자열로 돌려준다.
/// plugin-fs의 넓은 scope를 여는 대신 이 커맨드 하나만 노출하고, 검증을 여기서 전부 한다.
#[tauri::command]
fn read_markdown(
    app: AppHandle,
    opened: tauri::State<OpenedPaths>,
    path: String,
) -> Result<Document, String> {
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

    // 문서 안의 상대 경로 이미지를 asset protocol로 로드하려면 그 문서의 부모 디렉터리와 하위 폴더를 허용한다.
    if let Some(dir) = p.parent() {
        app.asset_protocol_scope()
            .allow_directory(dir, true)
            .map_err(|e| format!("이미지 경로를 허용할 수 없습니다: {e}"))?;
    }

    // 읽기에 성공한 경로만 쓰기 허용 목록에 들어간다.
    opened.0.lock().unwrap().insert(p.clone());

    Ok(Document {
        mtime_ms: mtime_ms(&p),
        path: p.to_string_lossy().to_string(),
        text,
    })
}

/// 저장 결과. 충돌이면 `conflict: true`로 돌려주고 프론트엔드가 확인을 받는다.
#[derive(serde::Serialize, Debug)]
struct SaveOutcome {
    conflict: bool,
    /// 저장에 성공했을 때의 새 수정 시각. 충돌이면 디스크의 현재 값.
    mtime_ms: u64,
}

/// 편집 내용을 파일에 쓴다.
///
/// - 이 세션에서 읽은 경로만 허용한다 (임의 경로 쓰기를 노출하지 않는다).
/// - `expected_mtime_ms`가 디스크와 다르면 쓰지 않고 충돌을 알린다. `force`면 무시하고 덮어쓴다.
/// - 임시 파일에 쓴 뒤 rename 한다 — 중간에 끊겨도 원본이 반쯤 덮이지 않는다.
/// 저장 정책과 실제 쓰기. Tauri 배관에서 분리해 두어 검증할 수 있게 한다.
fn save_document(
    opened: &HashSet<PathBuf>,
    p: &PathBuf,
    text: &str,
    expected_mtime_ms: u64,
    force: bool,
) -> Result<SaveOutcome, String> {
    if !opened.contains(p) {
        return Err("이 세션에서 열지 않은 파일에는 저장할 수 없습니다.".into());
    }

    let current = mtime_ms(p);
    if !force && expected_mtime_ms != 0 && current != 0 && current != expected_mtime_ms {
        return Ok(SaveOutcome {
            conflict: true,
            mtime_ms: current,
        });
    }

    let tmp = p.with_extension(format!(
        "{}.markview-tmp",
        p.extension().and_then(|e| e.to_str()).unwrap_or("md")
    ));
    // O_EXCL로 연다 — 미리 심어 둔 심볼릭 링크를 따라가 다른 파일을 덮어쓰지 않는다.
    // 이전에 남은 임시 이름(또는 링크)은 그 이름 자체만 지우고 한 번 더 시도한다.
    let write_tmp = || -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(text.as_bytes())
    };
    write_tmp()
        .or_else(|e| {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(e);
            }
            std::fs::remove_file(&tmp)?;
            write_tmp()
        })
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("쓸 수 없습니다: {e}")
        })?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("저장을 마칠 수 없습니다: {e}")
    })?;

    Ok(SaveOutcome {
        conflict: false,
        mtime_ms: mtime_ms(p),
    })
}

#[tauri::command]
fn write_markdown(
    opened: tauri::State<OpenedPaths>,
    path: String,
    text: String,
    expected_mtime_ms: u64,
    force: bool,
) -> Result<SaveOutcome, String> {
    let p = PathBuf::from(&path);
    let set = opened.0.lock().unwrap();
    save_document(&set, &p, &text, expected_mtime_ms, force)
}

/// 사용자가 이 세션에서 창에 드롭한 파일 경로. 이미지 복사(copy_asset)는 이 목록에 있는 경로만 받는다 —
/// 드롭 경로는 OS가 준 것이라 스크립트가 지어낼 수 없다.
#[derive(Default)]
struct DroppedPaths(Mutex<HashSet<PathBuf>>);

/// 편집 모드에서 붙여넣은 이미지(base64)를 문서 옆 assets/에 저장하고 상대 경로를 돌려준다.
/// 디스크 쓰기라 메인 스레드를 막지 않도록 async로 돈다.
#[tauri::command(async)]
fn save_asset(
    opened: tauri::State<OpenedPaths>,
    doc_path: String,
    ext: String,
    data: String,
) -> Result<String, String> {
    let set = opened.0.lock().unwrap();
    assets::save_asset(&set, &PathBuf::from(doc_path), &ext, &data)
}

/// 드롭한 이미지 파일을 문서 옆 assets/로 복사하고 상대 경로를 돌려준다.
#[tauri::command(async)]
fn copy_asset(
    opened: tauri::State<OpenedPaths>,
    dropped: tauri::State<DroppedPaths>,
    doc_path: String,
    src: String,
) -> Result<String, String> {
    let dropped = dropped.0.lock().unwrap().clone();
    let set = opened.0.lock().unwrap();
    assets::copy_asset(&set, &dropped, &PathBuf::from(doc_path), &PathBuf::from(src))
}

/// 이미지 편집 도구의 "경로 선택"(MarkText ImagePathPicker). Rust가 파일 대화상자를 띄우고, 고른 파일을
/// 바로 assets/로 복사해 상대 경로를 돌려준다(취소면 None). 대화상자를 스크립트에 열어 주지 않는다 —
/// JS 대화상자 API는 고른 폴더를 asset scope에 재귀로 열어 버린다.
#[tauri::command(async)]
fn pick_image(app: AppHandle, opened: tauri::State<OpenedPaths>, doc_path: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let doc = PathBuf::from(doc_path);
    if !opened.0.lock().unwrap().contains(&doc) {
        return Err("이 세션에서 열지 않은 문서에는 이미지를 저장할 수 없습니다.".into());
    }
    let picked = app
        .dialog()
        .file()
        .add_filter("이미지", &assets::IMAGE_EXT)
        .blocking_pick_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let set = opened.0.lock().unwrap();
    assets::store_file(&set, &doc, &path).map(Some)
}

/// 이미지 경로 입력의 자동 완성(문서 폴더 기준).
#[tauri::command]
fn list_image_paths(
    opened: tauri::State<OpenedPaths>,
    doc_path: String,
    partial: String,
) -> Vec<assets::PathSuggestion> {
    let set = opened.0.lock().unwrap();
    assets::list_image_paths(&set, &PathBuf::from(doc_path), &partial)
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
            &MenuItem::with_id(handle, "save", "Save", true, Some("CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(handle)?,
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
            // MarkText처럼 메뉴 가속기로 둔다 — 클립보드는 사용자가 이 키를 누를 때만 Rust가 읽어 넘긴다
            // (스크립트에 클립보드 읽기 권한을 주지 않는다).
            &MenuItem::with_id(
                handle,
                "paste-as-plaintext",
                "Paste as Plain Text",
                true,
                Some("Shift+CmdOrCtrl+V"),
            )?,
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
        .plugin(tauri_plugin_clipboard_manager::init())
        // 편집 모드 이미지 도구의 "경로 선택"(MarkText ImagePathPicker)이 여는 파일 대화상자.
        .plugin(tauri_plugin_dialog::init())
        .menu(|handle| build_menu(handle))
        .on_menu_event(|handle, event| {
            // 메뉴는 창 개수를 알지만 탭 개수는 모른다 — 탭 판단은 프론트엔드에 맡긴다.
            match event.id().as_ref() {
                "save" => {
                    let _ = handle.emit("save", ());
                }
                "close-tab" => {
                    let _ = handle.emit("close-tab", ());
                }
                "close-window" => {
                    let _ = handle.emit("close-window", ());
                }
                "paste-as-plaintext" => {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    if let Ok(text) = handle.clipboard().read_text() {
                        let _ = handle.emit("paste-as-plaintext", text);
                    }
                }
                _ => {}
            }
        })
        .manage(PendingFiles::default())
        .manage(OpenedPaths::default())
        .manage(DroppedPaths::default())
        .manage(CloseGuard::default())
        // 창 닫기 요청을 막고 프론트엔드에 넘긴다 — 미저장 문서 확인은 탭 상태를 아는 쪽이 해야 한다.
        .on_window_event(|window, event| {
            // 실제로 드롭된 경로를 기록한다 — 편집 모드의 이미지 복사는 이 경로만 받는다.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<DroppedPaths>().0.lock().unwrap().extend(paths.iter().cloned());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 통과 플래그가 서 있으면 내리고 그대로 닫히게 둔다.
                if window.state::<CloseGuard>().0.swap(false, Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_markdown,
            write_markdown,
            take_pending_files,
            allow_close,
            save_asset,
            copy_asset,
            pick_image,
            list_image_paths
        ])
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("markview-test-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn 열지_않은_파일에는_쓰지_못한다() {
        let d = tmpdir("guard");
        let f = d.join("a.md");
        std::fs::write(&f, "원본").unwrap();

        let err = save_document(&HashSet::new(), &f, "침입", 0, false).unwrap_err();
        assert!(err.contains("열지 않은"), "{err}");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "원본");
    }

    #[test]
    fn 열린_파일은_저장되고_임시파일이_남지_않는다() {
        let d = tmpdir("save");
        let f = d.join("a.md");
        std::fs::write(&f, "원본").unwrap();
        let opened: HashSet<PathBuf> = [f.clone()].into();
        let before = mtime_ms(&f);

        let out = save_document(&opened, &f, "# 새 내용\n", before, false).unwrap();
        assert!(!out.conflict);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "# 새 내용\n");
        assert_ne!(out.mtime_ms, 0);
        let leftovers: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("markview-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "임시파일 잔존: {leftovers:?}");
    }

    #[test]
    fn 외부_변경은_덮어쓰지_않고_충돌로_알린다() {
        let d = tmpdir("conflict");
        let f = d.join("a.md");
        std::fs::write(&f, "외부에서 바뀐 내용").unwrap();
        let opened: HashSet<PathBuf> = [f.clone()].into();

        let out = save_document(&opened, &f, "내 편집", 1, false).unwrap();
        assert!(out.conflict, "충돌을 감지하지 못했다");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "외부에서 바뀐 내용");

        let forced = save_document(&opened, &f, "내 편집", 1, true).unwrap();
        assert!(!forced.conflict);
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "내 편집");
    }

    #[test]
    fn 심어_둔_임시_파일_링크를_따라가_다른_파일을_덮어쓰지_않는다() {
        let d = tmpdir("save-link");
        let f = d.join("a.md");
        std::fs::write(&f, "원본").unwrap();
        let victim = tmpdir("save-link-victim").join("victim.txt");
        std::fs::write(&victim, "지켜야 할 파일").unwrap();
        // 문서 이름에서 정해지는 임시 파일 이름에 링크를 미리 심어 둔다(악성 저장소 시나리오).
        std::os::unix::fs::symlink(&victim, d.join("a.md.markview-tmp")).unwrap();
        let opened: HashSet<PathBuf> = [f.clone()].into();

        save_document(&opened, &f, "# 새 내용\n", 0, false).unwrap();

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "지켜야 할 파일");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "# 새 내용\n");
    }
}
