//! 편집 모드에서 붙여넣거나 드롭한 이미지를 문서 옆 `assets/`에 저장한다.
//!
//! MarkText의 "문서 기준 상대 폴더" 방식 그대로다: 파일 이름은 내용의 SHA-1(`<hash><확장자>`)이라
//! 같은 이미지를 두 번 넣어도 파일은 하나다(`copyFileWithContentHash`, `moveImageToFolder`).
//!
//! raw HTML을 허용했으므로(ADR 260822-222214) 이 IPC는 악성 문서의 스크립트에게도 열려 있다고 보고 좁힌다.
//! - 쓰기는 이 세션에서 연 문서의 폴더 밑 `assets/` 하나뿐이다(링크로 된 assets는 거부).
//! - 임시 파일은 O_EXCL로 만든다 — 미리 심어 둔 심볼릭 링크를 따라가 밖에 쓰지 않는다.
//! - 복사는 사용자가 실제로 드롭한 경로만 받는다(드롭 경로는 Rust가 창 이벤트에서 기록한다).
//!   경로 선택은 Rust가 띄운 대화상자에서 고른 파일만 바로 저장한다 — 스크립트가 경로를 고르지 못한다.

use base64::Engine;
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

/// MarkText가 이미지로 다루는 확장자(`utils/image.ts`의 EXT_REG).
pub const IMAGE_EXT: [&str; 6] = ["png", "jpg", "jpeg", "gif", "svg", "webp"];
const ASSETS_DIR: &str = "assets";
/// 한 장의 상한. 넘으면 메모리·디스크를 지키려고 거부한다.
const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

pub fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXT.contains(&ext.to_lowercase().as_str())
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

/// 연 문서의 assets 폴더(디스크의 실제 경로, 문서 기준 상대 이름). 없으면 만든다.
/// APFS는 대소문자를 구분하지 않으므로 이미 `Assets/`가 있으면 그것을 쓴다.
fn assets_dir(opened: &HashSet<PathBuf>, doc_path: &Path) -> Result<(PathBuf, String), String> {
    if !opened.contains(doc_path) {
        return Err("이 세션에서 열지 않은 문서에는 이미지를 저장할 수 없습니다.".into());
    }
    let dir = doc_path
        .parent()
        .ok_or("문서 폴더를 알 수 없습니다.")?
        .canonicalize()
        .map_err(|e| format!("문서 폴더를 찾을 수 없습니다: {e}"))?;
    let assets = dir.join(ASSETS_DIR);
    match std::fs::symlink_metadata(&assets) {
        // lstat: 링크를 따라가지 않으므로 링크로 된 assets는 여기서 걸러진다.
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => return Err("assets가 문서 폴더 안의 실제 폴더가 아닙니다.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&assets).map_err(|e| format!("assets 폴더를 만들 수 없습니다: {e}"))?;
        }
        Err(e) => return Err(format!("assets 폴더를 확인할 수 없습니다: {e}")),
    }
    let real = assets.canonicalize().map_err(|e| e.to_string())?;
    if real.parent() != Some(dir.as_path()) {
        return Err("assets가 문서 폴더 안의 실제 폴더가 아닙니다.".into());
    }
    let name = real.file_name().and_then(|n| n.to_str()).unwrap_or(ASSETS_DIR).to_string();
    Ok((real, name))
}

/// `dir/name`에 쓴다. 임시 파일을 O_EXCL로 만들어 링크를 따라가지 않고, 다 쓴 뒤 이름을 바꾼다.
fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.markview-tmp"));
    for attempt in 0..2 {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(mut file) => {
                let written = file.write_all(bytes).and_then(|_| file.sync_all());
                let renamed = written.and_then(|_| std::fs::rename(&tmp, dir.join(name)));
                return renamed.map_err(|e| {
                    let _ = std::fs::remove_file(&tmp);
                    format!("이미지를 쓸 수 없습니다: {e}")
                });
            }
            // 이전에 남은 임시 파일(또는 심어 둔 링크) — 그 이름 자체만 지우고 한 번 더.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                std::fs::remove_file(&tmp).map_err(|e| e.to_string())?;
            }
            Err(e) => return Err(format!("이미지를 쓸 수 없습니다: {e}")),
        }
    }
    Err("이미지를 쓸 수 없습니다.".into())
}

/// 바이트를 `<sha1>.<ext>`로 저장하고 문서 기준 상대 경로(`assets/<이름>`)를 돌려준다. 같은 이름이 있으면 그대로 쓴다.
fn store(opened: &HashSet<PathBuf>, doc_path: &Path, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let ext = ext.to_lowercase();
    if !is_image_ext(&ext) {
        return Err(format!("이미지 확장자가 아닙니다: {ext}"));
    }
    let (dir, rel_dir) = assets_dir(opened, doc_path)?;
    let name = format!("{:x}.{ext}", Sha1::digest(bytes));
    if std::fs::symlink_metadata(dir.join(&name)).is_err() {
        write_new(&dir, &name, bytes)?;
    }
    Ok(format!("{rel_dir}/{name}"))
}

/// 붙여넣은 이미지(base64)를 저장한다.
pub fn save_asset(opened: &HashSet<PathBuf>, doc_path: &Path, ext: &str, data: &str) -> Result<String, String> {
    if data.len() as u64 > MAX_IMAGE_BYTES / 3 * 4 + 4 {
        return Err("이미지가 너무 큽니다(상한 50MB).".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("이미지 데이터를 읽을 수 없습니다: {e}"))?;
    store(opened, doc_path, ext, &bytes)
}

/// 이미지 파일을 문서의 assets로 복사한다(이미 그 안에 있으면 그대로). 링크라면 실제 대상도 이미지여야 한다.
pub fn store_file(opened: &HashSet<PathBuf>, doc_path: &Path, src: &Path) -> Result<String, String> {
    let (dir, rel_dir) = assets_dir(opened, doc_path)?;
    let real = src.canonicalize().map_err(|_| format!("이미지 파일이 아닙니다: {}", src.display()))?;
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !is_image_ext(&ext_of(src)) || !is_image_ext(&ext_of(&real)) || !meta.is_file() {
        return Err(format!("이미지 파일이 아닙니다: {}", src.display()));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("이미지가 너무 큽니다(상한 50MB).".into());
    }
    if real.parent() == Some(dir.as_path()) {
        let name = real.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        return Ok(format!("{rel_dir}/{name}"));
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("이미지를 읽을 수 없습니다: {e}"))?;
    store(opened, doc_path, &ext_of(&real), &bytes)
}

/// 드롭한 이미지를 복사한다. 이 세션에서 사용자가 실제로 드롭한 경로만 받는다.
pub fn copy_asset(
    opened: &HashSet<PathBuf>,
    dropped: &HashSet<PathBuf>,
    doc_path: &Path,
    src: &Path,
) -> Result<String, String> {
    if !opened.contains(doc_path) {
        return Err("이 세션에서 열지 않은 문서에는 이미지를 저장할 수 없습니다.".into());
    }
    if !dropped.contains(src) {
        return Err("드롭한 파일만 복사할 수 있습니다.".into());
    }
    store_file(opened, doc_path, src)
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct PathSuggestion {
    pub file: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

/// 이미지 경로 자동 완성 — 문서 폴더 기준 상대 경로 `partial`의 폴더에서 이름이 이어지는 이미지·폴더.
/// 문서 폴더 밖(절대 경로·`..`·밖을 가리키는 링크 폴더)은 보여 주지 않는다(asset protocol이 허용하는 범위와 같다).
pub fn list_image_paths(opened: &HashSet<PathBuf>, doc_path: &Path, partial: &str) -> Vec<PathSuggestion> {
    if !opened.contains(doc_path) || partial.starts_with('/') || partial.split('/').any(|s| s == "..") {
        return Vec::new();
    }
    let Some(base) = doc_path.parent().and_then(|d| d.canonicalize().ok()) else {
        return Vec::new();
    };
    let (sub, prefix) = partial.rsplit_once('/').unwrap_or(("", partial));
    let Ok(dir) = base.join(sub).canonicalize() else {
        return Vec::new();
    };
    if !dir.starts_with(&base) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathSuggestion> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !name.starts_with(prefix) {
                return None;
            }
            let path = e.path();
            let kind = if path.is_dir() {
                "directory"
            } else if is_image_ext(&ext_of(&path)) {
                "file"
            } else {
                return None;
            };
            let file = if sub.is_empty() { name } else { format!("{sub}/{name}") };
            Some(PathSuggestion { file, kind })
        })
        .collect();
    out.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// lib.rs 테스트의 tmpdir과 같은 방식. macOS의 /var → /private/var 링크 때문에 정규화해 둔다.
    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("markview-assets-test-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn fixture(name: &str) -> (PathBuf, PathBuf, HashSet<PathBuf>) {
        let dir = tmpdir(name);
        let doc = dir.join("doc.md");
        std::fs::write(&doc, "# t").unwrap();
        let opened = HashSet::from([doc.clone()]);
        (dir, doc, opened)
    }

    const PNG: &str = "iVBORw0KGgo="; // 앞 8바이트(PNG 시그니처)만 — 내용은 무관하다

    #[test]
    fn 붙여넣은_이미지는_해시_이름으로_assets에_저장된다() {
        let (_d, doc, opened) = fixture("paste");
        let rel = save_asset(&opened, &doc, "png", PNG).unwrap();
        assert!(rel.starts_with("assets/") && rel.ends_with(".png"), "{rel}");
        assert!(doc.parent().unwrap().join(&rel).is_file());
        // 같은 내용이면 같은 파일
        assert_eq!(save_asset(&opened, &doc, "png", PNG).unwrap(), rel);
    }

    #[test]
    fn 열지_않은_문서에는_쓰지_않는다() {
        let (_d, doc, _opened) = fixture("guard");
        assert!(save_asset(&HashSet::new(), &doc, "png", PNG).is_err());
    }

    #[test]
    fn 이미지가_아닌_확장자는_거부한다() {
        let (_d, doc, opened) = fixture("ext");
        assert!(save_asset(&opened, &doc, "sh", PNG).is_err());
        assert!(save_asset(&opened, &doc, "../x", PNG).is_err());
    }

    #[test]
    fn 밖을_가리키는_assets_링크는_거부한다() {
        let (d, doc, opened) = fixture("symlink");
        let outside = tmpdir("symlink-outside");
        std::os::unix::fs::symlink(&outside, d.join(ASSETS_DIR)).unwrap();
        assert!(save_asset(&opened, &doc, "png", PNG).is_err());
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }

    #[test]
    fn 심어_둔_임시_파일_링크를_따라가지_않는다() {
        let (d, doc, opened) = fixture("tmp-link");
        let victim = tmpdir("tmp-link-victim").join("victim.txt");
        std::fs::write(&victim, "원본").unwrap();
        std::fs::create_dir(d.join(ASSETS_DIR)).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(PNG).unwrap();
        let name = format!("{:x}.png", Sha1::digest(&bytes));
        std::os::unix::fs::symlink(&victim, d.join(ASSETS_DIR).join(format!(".{name}.markview-tmp"))).unwrap();
        let rel = save_asset(&opened, &doc, "png", PNG).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "원본");
        let written = d.join(&rel);
        assert!(!std::fs::symlink_metadata(&written).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(&written).unwrap(), bytes);
    }

    #[test]
    fn 드롭한_파일만_복사되고_assets_안의_파일은_그대로다() {
        let (d, doc, opened) = fixture("copy");
        let src = d.join("pic.png");
        std::fs::write(&src, b"img").unwrap();
        assert!(copy_asset(&opened, &HashSet::new(), &doc, &src).is_err());
        let dropped = HashSet::from([src.clone()]);
        let rel = copy_asset(&opened, &dropped, &doc, &src).unwrap();
        assert!(rel.starts_with("assets/") && rel.ends_with(".png"));
        let inside = doc.parent().unwrap().join(&rel);
        assert_eq!(store_file(&opened, &doc, &inside).unwrap(), rel);
        assert!(store_file(&opened, &doc, &d.join("doc.md")).is_err());
    }

    #[test]
    fn 이미지_이름의_링크로_다른_파일을_복사하지_못한다() {
        let (d, doc, opened) = fixture("link-src");
        let secret = tmpdir("link-src-secret").join("id_rsa");
        std::fs::write(&secret, "비밀").unwrap();
        let link = d.join("logo.png");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let dropped = HashSet::from([link.clone()]);
        assert!(copy_asset(&opened, &dropped, &doc, &link).is_err());
        assert!(!d.join(ASSETS_DIR).exists() || std::fs::read_dir(d.join(ASSETS_DIR)).unwrap().count() == 0);
    }

    #[test]
    fn 대문자_assets_폴더도_쓴다() {
        let (d, doc, opened) = fixture("case");
        std::fs::create_dir(d.join("Assets")).unwrap();
        let rel = save_asset(&opened, &doc, "png", PNG).unwrap();
        // 대소문자를 구분하지 않는 볼륨이면 기존 Assets를, 구분하면 새 assets를 쓴다.
        assert!(rel.starts_with("Assets/") || rel.starts_with("assets/"), "{rel}");
        assert!(d.join(&rel).is_file());
    }

    #[test]
    fn 자동_완성은_문서_폴더_밖을_보여_주지_않는다() {
        let (d, doc, opened) = fixture("complete");
        std::fs::create_dir(d.join("img")).unwrap();
        std::fs::write(d.join("img/a.png"), b"x").unwrap();
        std::fs::write(d.join("img/notes.txt"), b"x").unwrap();
        assert_eq!(
            list_image_paths(&opened, &doc, "img/"),
            vec![PathSuggestion { file: "img/a.png".into(), kind: "file" }]
        );
        assert_eq!(
            list_image_paths(&opened, &doc, "i"),
            vec![PathSuggestion { file: "img".into(), kind: "directory" }]
        );
        assert!(list_image_paths(&opened, &doc, "../").is_empty());
        assert!(list_image_paths(&opened, &doc, "/etc/").is_empty());
    }
}
