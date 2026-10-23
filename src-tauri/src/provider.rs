//! 프로바이더(= 에이전트 프리셋 + 사용자 설정)의 설정과 진단.
//!
//! Paseo의 provider 항목에서 `enabled`·모델·진단을 차용했다. `command`·`env`는 차용하지 않는다 —
//! 설정 문자열이 곧 실행 명령이 되면 웹뷰가 뚫렸을 때 임의 명령 실행이 된다(ADR 261022-230253).
//! 모델도 문자열이지만 인자 하나로만 들어가고, 옵션으로 읽힐 수 없는 모양만 받는다.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::agent::{detach_session, kill_group};

const MAX_MODEL_CHARS: usize = 100;
const MAX_VERSION_CHARS: usize = 120;

fn yes() -> bool {
    true
}

/// 프로바이더 하나의 사용자 설정. 저장하지 않은 프로바이더는 기본값(켜짐, 모델 지정 없음)이다.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderSetting {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// CLI에 `--model`/`-m`로 넘길 값. 없으면 CLI 자신의 설정을 따른다.
    #[serde(default)]
    pub model: Option<String>,
}

impl Default for ProviderSetting {
    fn default() -> Self {
        ProviderSetting { enabled: true, model: None }
    }
}

/// 프리셋 id → 설정.
pub type Settings = HashMap<String, ProviderSetting>;

/// 모델 값을 검증한다. 앞뒤 공백을 자르고 비면 "지정 없음"(`None`)이다. 첫 글자는 영숫자여야 한다 —
/// `-`로 시작하면 CLI가 옵션으로 읽는다. 공백·셸 글자·너무 긴 값은 받지 않는다.
pub fn validate_model(raw: &str) -> Result<Option<String>, String> {
    let model = raw.trim();
    if model.is_empty() {
        return Ok(None);
    }
    let mut chars = model.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok = model.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@+-".contains(c));
    if model.chars().count() > MAX_MODEL_CHARS || !first_ok || !rest_ok {
        return Err("모델 이름은 영문자·숫자와 . _ : / @ + - 만 쓸 수 있고 영문자나 숫자로 시작해야 합니다".into());
    }
    Ok(Some(model.to_string()))
}

/// 저장된 설정을 읽는다. 알 수 없는 프리셋, 검증을 통과하지 못하는 모델, 깨진 파일은 기본값으로 본다 —
/// 파일은 Rust가 쓰지만 사이에 바뀌었을 수도 있으니 읽을 때 다시 검증한다.
pub fn load_settings(file: &Path, known: &[&str]) -> Settings {
    let Ok(text) = std::fs::read_to_string(file) else { return Settings::new() };
    let Ok(raw) = serde_json::from_str::<HashMap<String, ProviderSetting>>(&text) else { return Settings::new() };
    raw.into_iter()
        .filter(|(id, _)| known.contains(&id.as_str()))
        .map(|(id, mut setting)| {
            setting.model = setting.model.as_deref().and_then(|m| validate_model(m).ok().flatten());
            (id, setting)
        })
        .collect()
}

/// 임시 파일에 쓰고 이름을 바꿔 넣는다 — 쓰다 끊겨도 기존 파일이 깨지지 않는다.
pub fn save_settings(file: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
    std::fs::rename(&tmp, file)
}

/// `--version` 진단 결과. 모델을 호출하지 않는다.
#[derive(Debug, Serialize)]
pub struct Diagnostic {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(MAX_VERSION_CHARS).collect())
}

/// 실행 파일에 `--version`만 돌려 설치 상태를 본다. 못 찾았으면(`program`이 `None`) 설치되지 않은 것이다.
pub fn diagnose(program: Option<&Path>, path_env: Option<&str>, timeout: Duration) -> Diagnostic {
    let Some(program) = program else {
        return Diagnostic { installed: false, path: None, version: None, error: Some("실행 파일을 찾지 못했습니다".into()) };
    };
    let path = Some(program.to_string_lossy().into_owned());
    let fail = |error: String| Diagnostic { installed: true, path: path.clone(), version: None, error: Some(error) };

    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    detach_session(&mut cmd);
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("실행하지 못했습니다: {e}")),
    };
    let read = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read(Box::new(child.stdout.take().expect("piped")));
    let err = read(Box::new(child.stderr.take().expect("piped")));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                // 자손이 파이프를 쥐고 있어도 읽기 스레드가 끝나도록 그룹째 죽인다.
                kill_group(&mut child);
                break None;
            }
        }
    };
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        None => fail(format!("{}초 안에 끝나지 않았습니다", timeout.as_secs())),
        Some(s) if s.success() => match first_line(&stdout).or_else(|| first_line(&stderr)) {
            Some(version) => Diagnostic { installed: true, path, version: Some(version), error: None },
            None => fail("버전을 출력하지 않았습니다".into()),
        },
        Some(s) => fail(first_line(&stderr).or_else(|| first_line(&stdout)).unwrap_or_else(|| format!("오류로 끝났습니다({s})"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("markview-provider-{tag}-{}-{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[test]
    fn agent_provider_model_rejects_unsafe_values() {
        for ok in ["haiku", "gpt-6.1-sol", "opencode/big-pickle", "claude-3-5-sonnet@20241022", "o3:high", "a+b_c"] {
            assert_eq!(validate_model(ok), Ok(Some(ok.to_string())), "{ok}");
        }
        assert_eq!(validate_model("  haiku \n"), Ok(Some("haiku".into())), "앞뒤 공백은 자른다");
        assert_eq!(validate_model(""), Ok(None));
        assert_eq!(validate_model("   "), Ok(None));
        for bad in ["--yolo", "-x", "a b", "a;b", "$(id)", "a`b`", "a\nb", "a\"b", "한글", "/abs", ".hidden", &"a".repeat(101)] {
            assert!(validate_model(bad).is_err(), "{bad:?}");
        }
        assert!(validate_model(&"a".repeat(100)).is_ok());
    }

    #[test]
    fn agent_provider_settings_persist_across_restart_and_drop_stale_entries() {
        let dir = temp("persist");
        let file = dir.join("cfg").join("agent-providers.json");
        let mut settings = Settings::new();
        settings.insert("claude".into(), ProviderSetting { enabled: false, model: Some("haiku".into()) });
        settings.insert("codex".into(), ProviderSetting::default());
        save_settings(&file, &settings).unwrap();

        let loaded = load_settings(&file, &["claude", "codex", "opencode"]);
        assert_eq!(loaded.get("claude"), Some(&ProviderSetting { enabled: false, model: Some("haiku".into()) }));
        assert_eq!(loaded.get("codex"), Some(&ProviderSetting::default()));

        // 다른 파일에 알 수 없는 프리셋과 안전하지 않은 모델이 들어 있어도 걸러서 읽는다.
        let tampered = r#"{"claude":{"enabled":true,"model":"--yolo"},"gemini":{"enabled":false},"codex":{}}"#;
        std::fs::write(&file, tampered).unwrap();
        let loaded = load_settings(&file, &["claude", "codex", "opencode"]);
        assert_eq!(loaded.get("claude"), Some(&ProviderSetting { enabled: true, model: None }), "나쁜 모델은 지정 없음으로");
        assert_eq!(loaded.get("codex"), Some(&ProviderSetting::default()), "빠진 필드는 기본값");
        assert!(!loaded.contains_key("gemini"));
        std::fs::write(&file, "{ not json").unwrap();
        assert!(load_settings(&file, &["claude"]).is_empty());
        assert!(load_settings(&dir.join("none.json"), &["claude"]).is_empty());
    }

    #[test]
    fn agent_provider_diagnostic_reports_version_missing_and_failures() {
        let dir = temp("diag");
        let ok = script(&dir, "ok", "echo 'fake-cli 1.2.3 (build x)'");
        let d = diagnose(Some(&ok), None, Duration::from_secs(5));
        assert!(d.installed && d.error.is_none());
        assert_eq!(d.version.as_deref(), Some("fake-cli 1.2.3 (build x)"));
        assert_eq!(d.path.as_deref(), ok.to_str());

        let none = diagnose(None, None, Duration::from_secs(5));
        assert!(!none.installed && none.version.is_none() && none.error.is_some());

        let bad = script(&dir, "bad", "echo 'not logged in' >&2\nexit 3");
        let d = diagnose(Some(&bad), None, Duration::from_secs(5));
        assert!(d.installed && d.version.is_none());
        assert_eq!(d.error.as_deref(), Some("not logged in"));

        let silent = script(&dir, "silent", "true");
        assert!(diagnose(Some(&silent), None, Duration::from_secs(5)).error.is_some());

        let slow = script(&dir, "slow", "sleep 30");
        let t = Instant::now();
        let d = diagnose(Some(&slow), None, Duration::from_millis(300));
        assert!(d.error.as_deref().is_some_and(|e| e.contains("끝나지 않았습니다")));
        assert!(t.elapsed() < Duration::from_secs(5), "자손(sleep)이 파이프를 쥐어도 제때 돌아와야 한다");
    }
}
