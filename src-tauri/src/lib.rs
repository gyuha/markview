mod agent;
mod assets;
mod update;
mod windows;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use windows::{
    pick_target, plan_detach, restore_targets, Claim, CloseGuard, DetachOutcome, DetachPlan, LastFocus, RestoreEntry,
    TabbarHeight, WindowFiles, WindowInit, WindowLabels, WindowRect,
};

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

/// 프론트엔드가 "닫아도 된다"고 알리는 커맨드. 호출한 창의 다음 닫기 요청 한 번을 통과시킨다.
/// 통과 플래그는 창 라벨별이라 다른 창의 닫기에는 영향이 없다(통과 이유는 windows::CloseGuard 참고;
/// destroy()로 우회하면 더 짧지만 창 상태 저장을 건너뛸 수 있어 택하지 않았다).
#[tauri::command]
fn allow_close(window: tauri::WebviewWindow, guard: tauri::State<CloseGuard>) {
    guard.allow(window.label());
}

/// 이 창 말고 열려 있는 창의 수. 직접 닫는 창이 마지막인지 프론트엔드가 판단하는 데 쓴다 —
/// 마지막 창을 닫으면 다음 실행에서 분리했던 창이 되살아나지 않도록 모든 창의 세션을 지운다.
#[tauri::command]
fn other_window_count(app: AppHandle, window: tauri::WebviewWindow) -> usize {
    app.webview_windows().keys().filter(|label| label.as_str() != window.label()).count()
}

/// 호출한 창만 항상 위에 둔다(다른 창은 건드리지 않는다). 웹뷰에 창 권한을 주지 않고
/// 이 커맨드로만 열어 둔다(ADR 261010-234732). 상태는 저장하지 않으므로 앱을 다시 켜면 꺼져 있다.
#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
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

/// ⌘O의 "파일 열기" 대화상자. Rust가 창을 띄우고 고른 경로만 돌려준다(취소면 None).
/// 읽기와 asset scope는 건드리지 않는다 — JS가 이 경로를 read_markdown에 넘기면 거기서 확장자·크기·존재를
/// 다시 검증한다. pick_image와 같은 이유로 JS 대화상자 API는 쓰지 않는다.
#[tauri::command(async)]
fn pick_markdown(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .add_filter("마크다운", &ALLOWED_EXT)
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
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

/// 이 창이 파일을 열기 전에 소유를 요청한다. 다른 창이 이미 열고 있으면 그 창을 앞으로 가져오고
/// 그 창에 탭 활성화를 알린 뒤 "다른 창 소유"를 돌려준다 — 호출한 창은 탭을 만들지 않는다.
#[tauri::command]
fn claim_file(
    app: AppHandle,
    window: tauri::Window,
    files: tauri::State<WindowFiles>,
    path: String,
) -> Claim {
    let claim = files.claim(window.label(), &PathBuf::from(&path));
    if let Claim::OtherWindow(owner) = &claim {
        if let Some(w) = app.get_webview_window(owner) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit_to(owner.as_str(), "activate-tab", path);
    }
    claim
}

/// 탭을 닫을 때 그 파일의 소유를 푼다.
#[tauri::command]
fn release_file(window: tauri::Window, files: tauri::State<WindowFiles>, path: String) {
    files.release(window.label(), &PathBuf::from(path));
}

/// 새 창이 시작할 때 열 경로를 한 번 돌려준다. 분리로 만든 창만 값이 있고 메인 창은 항상 None이다.
#[tauri::command]
fn take_window_init(window: tauri::Window, init: tauri::State<WindowInit>) -> Option<String> {
    init.take(window.label())
}

/// 프론트엔드가 탭바 높이(논리 픽셀)를 시작 때 한 번 알린다 — 병합 판정의 탭바 띠 높이다.
#[tauri::command]
fn set_tabbar_height(height: f64, tabbar: tauri::State<TabbarHeight>) {
    tabbar.set(height);
}

/// 탭을 분리한다. 놓은 화면 좌표(논리 픽셀) 아래 가장 앞 창이 다른 창의 탭바 띠면 그 창으로 병합한다 —
/// 소유권을 옮기고 그 창에 `merge-in`(경로·화면 x)을 보내 삽입 위치는 대상 프론트엔드가 정한다.
/// 아니면 새 창을 만든다 — 창 생성은 Rust만 한다(웹뷰에는 창 생성 권한을 열지 않는다).
/// 소유권을 원 창에서 새 창으로 옮기고, 원 창과 같은 크기로 그 좌표에 창을 만든다.
/// 원 창의 탭을 닫는 것은 호출한 프론트엔드의 몫이다.
#[tauri::command]
async fn detach_tab(
    app: AppHandle,
    files: tauri::State<'_, WindowFiles>,
    labels: tauri::State<'_, WindowLabels>,
    init: tauri::State<'_, WindowInit>,
    focus: tauri::State<'_, LastFocus>,
    tabbar: tauri::State<'_, TabbarHeight>,
    from_label: String,
    path: String,
    screen_x: f64,
    screen_y: f64,
) -> Result<DetachOutcome, String> {
    let from = app
        .get_webview_window(&from_label)
        .ok_or_else(|| format!("창을 찾을 수 없습니다: {from_label}"))?;
    let size = from
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(from.scale_factor().map_err(|e| e.to_string())?);
    let alive: Vec<String> = app.webview_windows().keys().cloned().collect();
    let path_buf = PathBuf::from(&path);
    let rects: Vec<WindowRect> = app
        .webview_windows()
        .iter()
        .filter_map(|(label, w)| {
            let (pos, outer, inner) = (w.outer_position().ok()?, w.outer_size().ok()?, w.inner_size().ok()?);
            // 탭바 띠는 창 안쪽(웹뷰) 기준이므로 네이티브 제목 막대만큼 위를 잘라 낸다.
            let chrome = outer.height.saturating_sub(inner.height) as f64;
            Some(WindowRect {
                label: label.clone(),
                x: pos.x as f64,
                y: pos.y as f64 + chrome,
                width: outer.width as f64,
                height: inner.height as f64,
                scale: w.scale_factor().ok()?,
            })
        })
        .collect();
    if let DetachPlan::Merge(target) =
        plan_detach(&from_label, (screen_x, screen_y), &rects, &focus.order(), tabbar.get())
    {
        if !files.transfer(&from_label, &target, &path_buf) {
            return Err(format!("이 창이 열고 있는 파일이 아닙니다: {path}"));
        }
        if let Some(w) = app.get_webview_window(&target) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit_to(target.as_str(), "merge-in", serde_json::json!({ "path": path, "screen_x": screen_x }));
        return Ok(DetachOutcome::Merged);
    }
    let label = labels.alloc(&alive);
    if !files.transfer(&from_label, &label, &path_buf) {
        return Err(format!("이 창이 열고 있는 파일이 아닙니다: {path}"));
    }
    init.set(&label, path);
    let built = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::default())
        .title("markview")
        .inner_size(size.width, size.height)
        .position(screen_x, screen_y)
        .build();
    match built {
        Ok(w) => {
            // window-state 플러그인이 라벨 기준 저장값으로 위치·크기를 덮을 수 있어 생성 뒤 다시 지정한다.
            let _ = w.set_size(tauri::LogicalSize::new(size.width, size.height));
            let _ = w.set_position(tauri::LogicalPosition::new(screen_x, screen_y));
            Ok(DetachOutcome::Detached)
        }
        Err(e) => {
            // 창을 못 만들었으면 원 창이 계속 소유한다.
            files.transfer(&label, &from_label, &path_buf);
            init.take(&label);
            Err(e.to_string())
        }
    }
}

/// 메인 창이 시작할 때 저장된 창 세션마다 창을 되살린다. 라벨을 그대로 쓰므로 위치·크기는
/// window-state 플러그인이 복원하고, 창은 `take_window_init`으로 받은 경로로 자기 세션을 연다.
#[tauri::command]
async fn restore_windows(
    app: AppHandle,
    init: tauri::State<'_, WindowInit>,
    windows: Vec<RestoreEntry>,
) -> Result<(), String> {
    let alive: Vec<String> = app.webview_windows().keys().cloned().collect();
    for entry in restore_targets(&windows, &alive) {
        init.set(&entry.label, entry.path);
        let built = tauri::WebviewWindowBuilder::new(&app, &entry.label, tauri::WebviewUrl::default())
            .title("markview")
            .build();
        if built.is_err() {
            init.take(&entry.label);
        }
    }
    Ok(())
}

/// 메뉴·외부 열기를 받을 창의 라벨. 포커스 창 → 최근 포커스 창 → (아직 포커스를 받은 적 없는) main 순.
fn target_label(handle: &AppHandle) -> Option<String> {
    let windows = handle.webview_windows();
    let alive: Vec<String> = windows.keys().cloned().collect();
    let focused = windows.iter().find(|(_, w)| w.is_focused().unwrap_or(false)).map(|(l, _)| l.clone());
    let last = handle.state::<LastFocus>().get();
    pick_target(focused.as_deref(), last.as_deref(), &alive)
        .or_else(|| alive.iter().find(|l| *l == "main").cloned())
}

/// 대상 창에만 이벤트를 보낸다. 대상이 없으면 보낼 곳이 없으므로 버린다.
fn emit_to_target<S: serde::Serialize + Clone>(handle: &AppHandle, event: &str, payload: S) {
    if let Some(label) = target_label(handle) {
        let _ = handle.emit_to(label, event, payload);
    }
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
            &MenuItem::with_id(handle, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
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
        // 앱 안 업데이트. 확인·설치는 update.rs의 Rust 커맨드가 하고 웹뷰에는 updater 권한을 주지 않는다.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(|handle| build_menu(handle))
        .on_menu_event(|handle, event| {
            // 메뉴는 창 개수를 알지만 탭 개수는 모른다 — 탭 판단은 프론트엔드에 맡긴다.
            match event.id().as_ref() {
                "save" => {
                    emit_to_target(handle, "save", ());
                }
                "settings" => {
                    emit_to_target(handle, "open-settings", ());
                }
                "close-tab" => {
                    emit_to_target(handle, "close-tab", ());
                }
                "close-window" => {
                    emit_to_target(handle, "close-window", ());
                }
                "paste-as-plaintext" => {
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    if let Ok(text) = handle.clipboard().read_text() {
                        emit_to_target(handle, "paste-as-plaintext", text);
                    }
                }
                _ => {}
            }
        })
        .manage(PendingFiles::default())
        .manage(OpenedPaths::default())
        .manage(DroppedPaths::default())
        .manage(CloseGuard::default())
        .manage(LastFocus::default())
        .manage(TabbarHeight::default())
        .manage(WindowFiles::default())
        .manage(WindowLabels::default())
        .manage(WindowInit::default())
        .manage(update::PendingUpdate::default())
        .manage(agent::AgentState::default())
        // 창 닫기 요청을 막고 프론트엔드에 넘긴다 — 미저장 문서 확인은 탭 상태를 아는 쪽이 해야 한다.
        .on_window_event(|window, event| {
            // 실제로 드롭된 경로를 기록한다 — 편집 모드의 이미지 복사는 이 경로만 받는다.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<DroppedPaths>().0.lock().unwrap().extend(paths.iter().cloned());
            }
            if let tauri::WindowEvent::Focused(true) = event {
                window.state::<LastFocus>().set(window.label());
            }
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<WindowFiles>().release_all(window.label());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 통과 플래그가 서 있으면 내리고 그대로 닫히게 둔다.
                if window.state::<CloseGuard>().take(window.label()) {
                    return;
                }
                api.prevent_close();
                // 닫으려는 그 창에만 알린다 — window.emit은 모든 창에 방송한다.
                let _ = window.emit_to(window.label(), "close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_markdown,
            write_markdown,
            take_pending_files,
            allow_close,
            set_always_on_top,
            other_window_count,
            claim_file,
            release_file,
            take_window_init,
            set_tabbar_height,
            detach_tab,
            restore_windows,
            save_asset,
            copy_asset,
            pick_image,
            pick_markdown,
            list_image_paths,
            update::check_update,
            update::install_update,
            agent::detect_agents,
            agent::run_agent,
            agent::cancel_agent,
            agent::set_agent_path
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
            // 마지막 포커스 창이 가져가게 알린다. 아직 리스너 전이면 시작 시 버퍼를 비운다.
            // 받을 창이 하나도 없으면(모두 닫힘) 새 창을 만든다 — 새 창이 시작 때 버퍼를 비운다.
            match target_label(handle) {
                Some(label) => {
                    let _ = handle.emit_to(label, "files-opened", ());
                }
                None => {
                    let alive: Vec<String> = handle.webview_windows().keys().cloned().collect();
                    let label = handle.state::<WindowLabels>().alloc(&alive);
                    let _ = tauri::WebviewWindowBuilder::new(handle, &label, tauri::WebviewUrl::default())
                        .title("markview")
                        .build();
                }
            }
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
