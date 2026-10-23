//! AI 에이전트 CLI를 임시 사본에서 돌리는 실행기(ADR 261022-230253).
//!
//! 웹뷰는 프리셋 id·지시문·버퍼 텍스트만 넘긴다. 실행 파일 경로와 인자는 전부 여기서 정하고,
//! 에이전트는 임시 폴더의 사본 하나만 고친다 — 원본은 사용자가 수락해 저장하기 전까지 바뀌지 않는다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;

use tauri::{AppHandle, Emitter, Manager};

use crate::progress::{self, Parsed};
use crate::provider::{self, ProviderSetting, Settings};

/// 사본 파일 이름. 에이전트 프롬프트와 결과 읽기가 같은 이름을 쓴다.
const FILE_NAME: &str = "document.md";
/// 사본으로 넘기거나 받을 수 있는 최대 크기. `read_markdown`의 상한과 같다.
const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
/// 한 번의 실행이 돌 수 있는 최대 시간.
const RUN_TIMEOUT: Duration = Duration::from_secs(600);
/// 로그인 셸에서 PATH를 읽는 데 기다리는 최대 시간(.zshrc가 무거울 수 있다).
const SHELL_TIMEOUT: Duration = Duration::from_secs(8);

const PATH_BEGIN: &str = "__MV_PATH__";
const PATH_END: &str = "__MV_END__";

/// 앱이 이름을 알고 실행 방법을 아는 에이전트 CLI. 사용자가 명령 문자열을 정하는 길은 없다.
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    /// 실행 파일 이름. 탐색과 수동 경로 검증이 모두 이 이름만 받는다.
    pub bin: &'static str,
}

pub const PRESETS: [Preset; 3] = [
    Preset { id: "claude", name: "Claude Code", bin: "claude" },
    Preset { id: "codex", name: "Codex", bin: "codex" },
    Preset { id: "opencode", name: "OpenCode", bin: "opencode" },
];

fn find_preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// 프리셋 하나의 실행 인자와 환경 변수. 쓰기를 임시 폴더로 좁히는 옵션은 CLI마다 다르다
/// (`--help`로 확인한 값). 보조 수단일 뿐이고, 문서 파일의 보장은 임시 사본이 한다.
pub struct Invocation {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// 사용자 지시문을 감싼 전체 프롬프트. 항상 고정 문장으로 시작해서 지시문이 `-`로 시작해도
/// CLI가 옵션으로 읽지 못한다.
pub fn build_prompt(instruction: &str) -> String {
    format!(
        "현재 폴더의 {FILE_NAME} 마크다운 문서를 아래 지시에 따라 수정해 줘. 이 파일만 직접 고치고 \
         다른 파일은 만들거나 바꾸지 마.\n\n지시:\n{instruction}"
    )
}

/// `model`은 `provider::validate_model`을 통과한 값이어야 한다(옵션처럼 읽히는 값은 거기서 걸러진다).
/// 모델 인자는 프롬프트 앞에 두고, 모델이 없으면 인자를 더하지 않는다.
pub fn build_invocation(preset_id: &str, prompt: &str, workdir: &Path, model: Option<&str>) -> Option<Invocation> {
    let s = |v: &str| v.to_string();
    let dir = workdir.to_string_lossy().into_owned();
    let with_model = |flag: &str| -> Vec<String> { model.map(|m| vec![s(flag), s(m)]).unwrap_or_default() };
    let (args, env) = match preset_id {
        // 도구를 읽기·편집·쓰기로 줄이고, 프롬프트가 필요한 요청은 묻지 않고 거부한다.
        "claude" => (
            [
                with_model("--model"),
                vec![
                    s("--permission-mode"), s("acceptEdits"), s("--permission-prompts"), s("none"),
                    s("--tools"), s("Read,Edit,Write"),
                    // 진행 단계를 줄 단위 JSON으로 받는다(`-p`는 끝날 때까지 아무것도 찍지 않는다). stream-json은 --verbose가 필요하다.
                    s("--output-format"), s("stream-json"), s("--verbose"),
                    s("-p"), s(prompt),
                ],
            ]
            .concat(),
            vec![],
        ),
        "codex" => (
            [
                vec![s("exec"), s("--json"), s("--sandbox"), s("workspace-write"), s("--skip-git-repo-check"), s("--ephemeral")],
                with_model("-m"),
                vec![s("--color"), s("never"), s("-C"), dir, s(prompt)],
            ]
            .concat(),
            vec![],
        ),
        "opencode" => (
            [vec![s("run"), s("--format"), s("json")], with_model("-m"), vec![s("--dir"), dir, s(prompt)]].concat(),
            vec![(
                s("OPENCODE_CONFIG_CONTENT"),
                s(r#"{"permission":{"edit":"allow","bash":"deny","webfetch":"deny"}}"#),
            )],
        ),
        _ => return None,
    };
    Some(Invocation { args, env })
}

// ---- CLI 탐색 ---------------------------------------------------------------

/// `-ilc` 출력에서 마커 사이의 PATH를 꺼낸다. 셸 시작 파일이 찍는 잡음은 마커 밖에 있다.
fn parse_marked_path(output: &str) -> Option<String> {
    let begin = output.find(PATH_BEGIN)? + PATH_BEGIN.len();
    let end = begin + output[begin..].find(PATH_END)?;
    Some(output[begin..end].to_string())
}

/// 로그인 셸이 만드는 PATH. GUI 앱은 셸 PATH를 상속하지 않고 mise·nvm 같은 도구는 셸 시작 파일에서
/// PATH를 만든다. 시작 파일(.zshrc)까지 읽도록 `-i`를 쓰고 stdin은 닫는다.
fn login_shell_path(shell: &Path, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", &format!("printf '{PATH_BEGIN}%s{PATH_END}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    detach_session(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                // 셸이 띄운 자손이 파이프를 쥐고 있어도 읽기 스레드가 끝나도록 그룹째 죽인다.
                kill_group(&mut child);
                break;
            }
        }
    }
    let buf = reader.join().ok()?;
    parse_marked_path(&String::from_utf8_lossy(&buf))
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn find_in_path(bin: &str, path: &str) -> Option<PathBuf> {
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(bin)).find(|p| is_executable(p))
}

/// 수동으로 지정한 경로를 받아도 되는지. 파일명이 프리셋 실행 파일 이름과 같은 실행 파일만 받는다 —
/// 웹뷰가 `/bin/sh` 같은 임의 실행 파일을 가리키지 못하게 한다.
pub fn validate_manual_path(preset_id: &str, path: &str) -> Result<PathBuf, String> {
    let p = find_preset(preset_id).ok_or("알 수 없는 에이전트입니다")?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("절대 경로가 필요합니다".into());
    }
    if path.file_name().and_then(|n| n.to_str()) != Some(p.bin) {
        return Err(format!("파일 이름이 {}이어야 합니다", p.bin));
    }
    if !is_executable(&path) {
        return Err("실행할 수 있는 파일이 아닙니다".into());
    }
    Ok(path)
}

#[derive(Clone)]
struct AgentCache {
    shell_path: String,
    found: HashMap<&'static str, PathBuf>,
}

type Overrides = HashMap<&'static str, PathBuf>;

/// 수동으로 지정한 경로가 있고 아직 실행할 수 있으면 그것을, 아니면 PATH에서 찾은 것을 쓴다.
fn detect(shell_path: String, overrides: &Overrides) -> AgentCache {
    let found = PRESETS
        .iter()
        .filter_map(|p| {
            overrides
                .get(p.id)
                .filter(|path| is_executable(path))
                .cloned()
                .or_else(|| find_in_path(p.bin, &shell_path))
                .map(|path| (p.id, path))
        })
        .collect();
    AgentCache { shell_path, found }
}

/// 저장된 수동 경로를 읽는다. 알 수 없는 프리셋, 지금은 검증을 통과하지 못하는 경로, 깨진 파일은 없는 것으로 본다 —
/// 파일은 웹뷰가 아니라 Rust가 쓰지만, 사이에 파일이 바뀌었을 수도 있으니 읽을 때 다시 검증한다.
fn load_overrides(file: &Path) -> Overrides {
    let Ok(text) = std::fs::read_to_string(file) else { return Overrides::new() };
    let Ok(raw) = serde_json::from_str::<HashMap<String, String>>(&text) else { return Overrides::new() };
    PRESETS
        .iter()
        .filter_map(|p| {
            let path = raw.get(p.id)?;
            validate_manual_path(p.id, path).ok().map(|path| (p.id, path))
        })
        .collect()
}

/// 임시 파일에 쓰고 이름을 바꿔 넣는다 — 쓰다 끊겨도 기존 파일이 깨지지 않는다.
fn save_overrides(file: &Path, overrides: &Overrides) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let raw: HashMap<&str, String> = overrides.iter().map(|(id, p)| (*id, p.to_string_lossy().into_owned())).collect();
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&raw)?)?;
    std::fs::rename(&tmp, file)
}

fn user_shell() -> PathBuf {
    std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| "/bin/zsh".into())
}

/// 로그인 셸에서 읽은 PATH를 우선하고, 앱 프로세스가 물려받은 PATH도 뒤에 덧붙여
/// 로그인 셸 호출이 실패하거나 비어 있어도 기본 PATH 탐색이 살아 있게 한다.
fn effective_path(login: Option<String>, inherited: Option<String>) -> String {
    match (login.filter(|s| !s.is_empty()), inherited.filter(|s| !s.is_empty())) {
        (Some(l), Some(i)) => format!("{l}:{i}"),
        (Some(l), None) => l,
        (None, Some(i)) => i,
        (None, None) => String::new(),
    }
}

// ---- 실행 -------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum AgentError {
    Cancelled,
    TimedOut,
    Failed(String),
}

impl AgentError {
    fn message(&self) -> String {
        match self {
            AgentError::Cancelled => "취소했습니다".into(),
            AgentError::TimedOut => format!("{}분 안에 끝나지 않아 중단했습니다", RUN_TIMEOUT.as_secs() / 60),
            AgentError::Failed(m) => m.clone(),
        }
    }
}

/// 실행마다 만드는 임시 폴더. 지워지는 것은 이 폴더 안뿐이다.
struct WorkDir(PathBuf);

static WORKDIR_SEQ: AtomicU64 = AtomicU64::new(0);

impl WorkDir {
    fn create() -> std::io::Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "markview-agent-{}-{}-{nanos}",
            std::process::id(),
            WORKDIR_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        // 이미 있으면 실패한다 — 심어 둔 폴더나 링크를 따라가지 않는다.
        std::fs::create_dir(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(WorkDir(dir))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 새 세션(자신이 리더인 새 프로세스 그룹)에서 자식을 띄운다.
/// `process_group(0)`(`setpgid`)만 쓰면 부모의 제어 터미널(`/dev/tty`)이 그대로 물려 내려가서,
/// 터미널에서 띄운 앱이 `zsh -i`를 부를 때 백그라운드 그룹의 터미널 접근(`SIGTTOU`/`SIGTTIN`)으로 멈춘다.
/// `setsid`는 제어 터미널을 떼어 내면서 동시에 `pgid == pid`인 프로세스 그룹을 만들어 `kill_group`도 그대로 동작한다.
pub(crate) fn detach_session(cmd: &mut Command) {
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

/// 프로세스 그룹 전체를 죽인다. 에이전트가 띄운 자손도 같이 끝낸다.
pub(crate) fn kill_group(child: &mut Child) {
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[derive(Clone, Copy)]
pub enum Stream {
    Out,
    Err,
}

fn pump(reader: impl Read + Send + 'static, stream: Stream, on_line: Arc<dyn Fn(Stream, String) + Send + Sync>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).split(b'\n').map_while(Result::ok) {
            on_line(stream, String::from_utf8_lossy(&line).trim_end_matches('\r').to_string());
        }
    })
}

/// 임시 폴더에 `text`를 쓰고, 그 폴더를 cwd로 `program`을 돌린 뒤 고쳐진 텍스트를 돌려준다.
/// `make_invocation`은 임시 폴더 경로를 받아 인자를 만든다(프리셋별 인자는 `build_invocation`).
pub fn run_in_workdir(
    program: &Path,
    path_env: Option<&str>,
    make_invocation: impl FnOnce(&Path) -> Invocation,
    text: &str,
    cancel: &AtomicBool,
    timeout: Duration,
    on_line: Arc<dyn Fn(Stream, String) + Send + Sync>,
) -> Result<String, AgentError> {
    if text.len() > MAX_BYTES {
        return Err(AgentError::Failed("문서가 너무 큽니다(5MB 초과)".into()));
    }
    let work = WorkDir::create().map_err(|e| AgentError::Failed(format!("임시 폴더를 만들지 못했습니다: {e}")))?;
    let file = work.0.join(FILE_NAME);
    std::fs::write(&file, text).map_err(|e| AgentError::Failed(format!("임시 사본을 쓰지 못했습니다: {e}")))?;

    let inv = make_invocation(&work.0);
    let mut cmd = Command::new(program);
    cmd.args(&inv.args)
        .current_dir(&work.0)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    detach_session(&mut cmd);
    if let Some(p) = path_env {
        cmd.env("PATH", p);
    }
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| AgentError::Failed(format!("실행하지 못했습니다: {e}")))?;
    let readers = [
        pump(child.stdout.take().expect("piped"), Stream::Out, on_line.clone()),
        pump(child.stderr.take().expect("piped"), Stream::Err, on_line),
    ];

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        if cancel.load(Ordering::SeqCst) {
            kill_group(&mut child);
            break Err(AgentError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                kill_group(&mut child);
                break Err(AgentError::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
            Err(e) => {
                kill_group(&mut child);
                break Err(AgentError::Failed(e.to_string()));
            }
        }
    };
    // 그룹이 이미 죽었거나 정상 종료라 파이프는 곧 닫힌다.
    for r in readers {
        let _ = r.join();
    }
    let status = outcome?;
    if !status.success() {
        return Err(AgentError::Failed(format!("에이전트가 오류로 끝났습니다({status})")));
    }
    let bytes = std::fs::read(&file).map_err(|_| AgentError::Failed("에이전트가 사본을 남기지 않았습니다".into()))?;
    if bytes.len() > MAX_BYTES {
        return Err(AgentError::Failed("결과가 너무 큽니다(5MB 초과)".into()));
    }
    String::from_utf8(bytes).map_err(|_| AgentError::Failed("결과가 UTF-8 텍스트가 아닙니다".into()))
}

// ---- 연결 시험 --------------------------------------------------------------

const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_secs(180);
const PROBE_DOC: &str = "# 연결 시험\n";
const PROBE_MARK: &str = "연결 확인";
const PROBE_INSTRUCTION: &str = "문서 맨 끝에 `- 연결 확인` 한 줄을 덧붙여 줘.";

/// 작은 실제 호출로 이 프로바이더가 쓸 수 있는지 본다. 실패하면 CLI가 마지막으로 낸 줄을 오류에 붙인다 —
/// 로그인이 안 됐거나 계정 문제일 때 그 이유가 거기 있다.
fn probe_provider(
    preset: &str,
    program: &Path,
    path_env: Option<&str>,
    make_invocation: impl FnOnce(&Path) -> Invocation,
    timeout: Duration,
) -> Result<String, String> {
    let last = Arc::new(Mutex::new(String::new()));
    let sink = last.clone();
    let preset = preset.to_string();
    let started = Instant::now();
    let out = run_in_workdir(
        program,
        path_env,
        make_invocation,
        PROBE_DOC,
        &AtomicBool::new(false),
        timeout,
        Arc::new(move |stream, line| {
            // 실패 이유가 될 만한 줄만 남긴다: 원문 줄과 오류·경고 단계. JSON 이벤트 원문은 읽을 수 없다.
            match progress::interpret(&preset, matches!(stream, Stream::Out), &line) {
                Parsed::Raw(text) => *sink.lock().unwrap() = text,
                Parsed::Events(events) => {
                    if let Some(e) = events.into_iter().rev().find(|e| e.kind == "error" || e.kind == "warning") {
                        *sink.lock().unwrap() = e.text;
                    }
                }
                Parsed::Skip => {}
            }
        }),
    );
    match out {
        Ok(text) if text != PROBE_DOC && text.contains(PROBE_MARK) => Ok(format!("OK ({}초)", started.elapsed().as_secs())),
        Ok(_) => Err("에이전트가 문서를 고치지 않았습니다".into()),
        Err(e) => {
            let last = last.lock().unwrap().clone();
            Err(if last.is_empty() { e.message() } else { format!("{} — {last}", e.message()) })
        }
    }
}

// ---- IPC --------------------------------------------------------------------

/// 창 라벨 + 탭 경로가 한 실행의 키다. 같은 키의 두 번째 실행은 막고 다른 탭·창은 독립으로 돌린다.
/// 경로는 키로만 쓰고 파일을 읽거나 쓰는 데는 쓰지 않는다.
fn run_key(window_label: &str, tab_path: &str) -> String {
    format!("{window_label}\n{tab_path}")
}

#[derive(Default)]
pub struct AgentState {
    cache: Mutex<Option<AgentCache>>,
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 사용자가 설정 창에서 지정한 실행 파일 경로. 앱 설정 폴더의 `agent-paths.json`에 저장된다.
    overrides: Mutex<Overrides>,
    config_file: Mutex<Option<PathBuf>>,
    /// 프로바이더별 활성·모델. 앱 설정 폴더의 `agent-providers.json`에 저장된다.
    providers: Mutex<Settings>,
    providers_file: Mutex<Option<PathBuf>>,
}

impl AgentState {
    /// 이미 실행 중이면 `None`. 아니면 취소 플래그를 만들어 등록한다.
    fn begin(&self, key: &str) -> Option<Arc<AtomicBool>> {
        let mut runs = self.runs.lock().unwrap();
        if runs.contains_key(key) {
            return None;
        }
        let flag = Arc::new(AtomicBool::new(false));
        runs.insert(key.to_string(), flag.clone());
        Some(flag)
    }

    fn end(&self, key: &str) {
        self.runs.lock().unwrap().remove(key);
    }

    fn cancel(&self, key: &str) {
        if let Some(flag) = self.runs.lock().unwrap().get(key) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// 저장 파일을 정하고 거기 있던 수동 경로를 불러온다. 처음 한 번만 한다.
    fn use_config_file(&self, file: PathBuf) {
        let mut slot = self.config_file.lock().unwrap();
        if slot.is_none() {
            *self.overrides.lock().unwrap() = load_overrides(&file);
            *slot = Some(file);
        }
    }

    /// 프로바이더 설정 파일을 정하고 거기 있던 설정을 불러온다. 처음 한 번만 한다.
    fn use_providers_file(&self, file: PathBuf) {
        let mut slot = self.providers_file.lock().unwrap();
        if slot.is_none() {
            let known: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
            *self.providers.lock().unwrap() = provider::load_settings(&file, &known);
            *slot = Some(file);
        }
    }

    fn init(&self, app: &AppHandle) {
        if let Ok(dir) = app.path().app_config_dir() {
            self.use_config_file(dir.join("agent-paths.json"));
            self.use_providers_file(dir.join("agent-providers.json"));
        }
    }

    /// 프로바이더의 설정. 저장한 적이 없으면 기본값(켜짐, 모델 지정 없음).
    fn provider(&self, preset_id: &str) -> ProviderSetting {
        self.providers.lock().unwrap().get(preset_id).cloned().unwrap_or_default()
    }

    /// 활성 여부와 모델을 바꾼다. `None`인 항목은 그대로 둔다. 모델은 빈 문자열이면 지정을 지운다.
    /// 검증을 통과하지 못하면 아무것도 바꾸지 않는다.
    fn set_provider(&self, preset_id: &str, enabled: Option<bool>, model: Option<&str>) -> Result<ProviderSetting, String> {
        let id = find_preset(preset_id).ok_or("알 수 없는 에이전트입니다")?.id;
        let mut next = self.providers.lock().unwrap().clone();
        let mut setting = next.get(id).cloned().unwrap_or_default();
        if let Some(on) = enabled {
            setting.enabled = on;
        }
        if let Some(raw) = model {
            setting.model = provider::validate_model(raw)?;
        }
        next.insert(id.to_string(), setting.clone());
        if let Some(file) = self.providers_file.lock().unwrap().as_ref() {
            provider::save_settings(file, &next).map_err(|e| format!("저장하지 못했습니다: {e}"))?;
        }
        *self.providers.lock().unwrap() = next;
        Ok(setting)
    }

    /// 꺼진 프로바이더는 실행하지 않는다.
    fn ensure_enabled(&self, preset_id: &str) -> Result<(), String> {
        if self.provider(preset_id).enabled {
            Ok(())
        } else {
            Err("이 프로바이더는 설정에서 꺼져 있습니다".into())
        }
    }

    fn cache(&self, refresh: bool) -> AgentCache {
        let mut guard = self.cache.lock().unwrap();
        if refresh || guard.is_none() {
            let shell_path = effective_path(login_shell_path(&user_shell(), SHELL_TIMEOUT), std::env::var("PATH").ok());
            *guard = Some(detect(shell_path, &self.overrides.lock().unwrap()));
        }
        guard.clone().expect("just set")
    }

    /// 수동 경로를 정한다. 빈 문자열이면 지정을 지운다. 검증을 통과하지 못하면 아무것도 바꾸지 않는다.
    fn set_path(&self, preset_id: &str, path: &str) -> Result<(), String> {
        let id = find_preset(preset_id).ok_or("알 수 없는 에이전트입니다")?.id;
        let mut next = self.overrides.lock().unwrap().clone();
        if path.trim().is_empty() {
            next.remove(id);
        } else {
            next.insert(id, validate_manual_path(id, path.trim())?);
        }
        if let Some(file) = self.config_file.lock().unwrap().as_ref() {
            save_overrides(file, &next).map_err(|e| format!("저장하지 못했습니다: {e}"))?;
        }
        *self.overrides.lock().unwrap() = next.clone();
        // 셸 PATH는 다시 읽지 않는다(느리다). 찾은 경로만 새 지정으로 다시 계산한다.
        if let Some(cache) = self.cache.lock().unwrap().as_mut() {
            *cache = detect(std::mem::take(&mut cache.shell_path), &next);
        }
        Ok(())
    }
}

#[derive(serde::Serialize)]
pub struct DetectedAgent {
    id: &'static str,
    name: &'static str,
    /// 찾은 실행 파일 경로. 못 찾았으면 `None`.
    path: Option<String>,
    /// 설정 창에서 켜 둔 프로바이더인가(기본 켜짐).
    enabled: bool,
    /// 설정 창에서 정한 모델. 없으면 CLI 자신의 설정을 따른다.
    model: Option<String>,
}

#[derive(serde::Serialize, Clone)]
struct AgentLog {
    path: String,
    stream: &'static str,
    /// 해석한 진행 단계의 종류(status·thinking·tool·message·warning·error). 원문 줄이면 없다.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    line: String,
}

/// 프리셋 3개의 탐색 결과. `refresh`면 로그인 셸에서 PATH를 다시 읽는다.
#[tauri::command]
pub async fn detect_agents(app: AppHandle, refresh: Option<bool>) -> Result<Vec<DetectedAgent>, String> {
    let (cache, state_app) = (app.clone(), app);
    let cache = tauri::async_runtime::spawn_blocking(move || {
        let state = cache.state::<AgentState>();
        state.init(&cache);
        state.cache(refresh.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?;
    let state = state_app.state::<AgentState>();
    Ok(PRESETS
        .iter()
        .map(|p| {
            let setting = state.provider(p.id);
            DetectedAgent {
                id: p.id,
                name: p.name,
                path: cache.found.get(p.id).map(|f| f.to_string_lossy().into_owned()),
                enabled: setting.enabled,
                model: setting.model,
            }
        })
        .collect())
}

/// 웹뷰가 넘긴 요청에서 실행 전에 거를 수 있는 것들. 프리셋은 id로만 고른다.
fn validate_request(preset_id: &str, prompt: &str) -> Result<(), String> {
    if find_preset(preset_id).is_none() {
        return Err("알 수 없는 에이전트입니다".into());
    }
    if prompt.trim().is_empty() {
        return Err("지시문이 비어 있습니다".into());
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err("지시문이 너무 깁니다".into());
    }
    Ok(())
}

/// 지시문과 현재 편집 버퍼를 에이전트에 넘기고 고쳐진 텍스트를 돌려준다. 로그는 `agent-log` 이벤트로
/// 호출한 창에만 간다. 문서 파일은 건드리지 않는다 — 수락과 저장은 웹뷰가 기존 경로로 한다.
#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    window: tauri::WebviewWindow,
    preset: String,
    prompt: String,
    text: String,
    path: String,
) -> Result<String, String> {
    validate_request(&preset, &prompt)?;
    {
        let state = app.state::<AgentState>();
        state.init(&app);
        state.ensure_enabled(&preset)?;
    }
    let label = window.label().to_string();
    let key = run_key(&label, &path);
    let cancel = app.state::<AgentState>().begin(&key).ok_or("이 탭에서 이미 실행 중입니다")?;

    let task_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = task_app.state::<AgentState>();
        state.init(&task_app);
        let cache = state.cache(false);
        let program = cache.found.get(preset.as_str()).cloned().ok_or(AgentError::Failed(
            "이 에이전트의 실행 파일을 찾지 못했습니다".into(),
        ))?;
        let full_prompt = build_prompt(&prompt);
        let model = state.provider(&preset).model;
        let emit_app = task_app.clone();
        let log_preset = preset.clone();
        // CLI의 스트리밍 JSON을 진행 단계로 바꿔 보낸다. 해석할 수 없는 줄은 원문 그대로, 훅 같은 잡음은 버린다.
        let on_line: Arc<dyn Fn(Stream, String) + Send + Sync> = Arc::new(move |stream, line| {
            let from_stdout = matches!(stream, Stream::Out);
            let send = |kind: Option<&'static str>, line: String| {
                let payload = AgentLog { path: path.clone(), stream: if from_stdout { "out" } else { "err" }, kind, line };
                let _ = emit_app.emit_to(label.as_str(), "agent-log", payload);
            };
            match progress::interpret(&log_preset, from_stdout, &line) {
                Parsed::Events(events) => events.into_iter().for_each(|e| send(Some(e.kind), e.text)),
                Parsed::Raw(text) => send(None, text),
                Parsed::Skip => {}
            }
        });
        run_in_workdir(
            &program,
            (!cache.shell_path.is_empty()).then_some(cache.shell_path.as_str()),
            |dir| build_invocation(&preset, &full_prompt, dir, model.as_deref()).expect("preset checked"),
            &text,
            &cancel,
            RUN_TIMEOUT,
            on_line,
        )
    })
    .await;
    app.state::<AgentState>().end(&key);
    match result {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(e)) => Err(e.message()),
        Err(e) => Err(e.to_string()),
    }
}

/// 설정 창의 프로바이더 설정. `enabled`·`model` 중 넘긴 것만 바꾼다. 모델은 빈 문자열이면 지정을 지운다.
/// 모델 값은 여기서 다시 검증한다 — 웹뷰가 넘긴 값을 믿지 않는다.
#[tauri::command]
pub fn set_provider_settings(
    app: AppHandle,
    state: tauri::State<AgentState>,
    preset: String,
    enabled: Option<bool>,
    model: Option<String>,
) -> Result<(), String> {
    state.init(&app);
    state.set_provider(&preset, enabled, model.as_deref()).map(|_| ())
}

/// 이 프로바이더 CLI에 `--version`만 돌려 설치 상태를 본다(모델 호출 없음).
#[tauri::command]
pub async fn provider_diagnostic(app: AppHandle, preset: String) -> Result<provider::Diagnostic, String> {
    if find_preset(&preset).is_none() {
        return Err("알 수 없는 에이전트입니다".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AgentState>();
        state.init(&app);
        let cache = state.cache(false);
        provider::diagnose(
            cache.found.get(preset.as_str()).map(PathBuf::as_path),
            (!cache.shell_path.is_empty()).then_some(cache.shell_path.as_str()),
            DIAGNOSTIC_TIMEOUT,
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// 연결 시험 — 임시 사본에 한 줄을 덧붙이는 작은 실제 호출. 사용자가 눌렀을 때만 부른다.
/// 꺼진 프로바이더도 시험할 수 있다(켜기 전에 되는지 보려는 것이다).
#[tauri::command]
pub async fn test_provider(app: AppHandle, window: tauri::WebviewWindow, preset: String) -> Result<String, String> {
    if find_preset(&preset).is_none() {
        return Err("알 수 없는 에이전트입니다".into());
    }
    let key = run_key(window.label(), &format!("provider-test:{preset}"));
    app.state::<AgentState>().begin(&key).ok_or("이미 시험 중입니다")?;
    let task_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = task_app.state::<AgentState>();
        state.init(&task_app);
        let cache = state.cache(false);
        let program = cache.found.get(preset.as_str()).cloned().ok_or("이 에이전트의 실행 파일을 찾지 못했습니다")?;
        let model = state.provider(&preset).model;
        let prompt = build_prompt(PROBE_INSTRUCTION);
        probe_provider(
            &preset,
            &program,
            (!cache.shell_path.is_empty()).then_some(cache.shell_path.as_str()),
            |dir| build_invocation(&preset, &prompt, dir, model.as_deref()).expect("preset checked"),
            PROBE_TIMEOUT,
        )
    })
    .await;
    app.state::<AgentState>().end(&key);
    result.map_err(|e| e.to_string())?
}

/// 설정 창의 수동 경로. 파일명이 프리셋 실행 파일 이름과 같은 실행 파일만 받고, 빈 문자열은 지정을 지운다.
#[tauri::command]
pub fn set_agent_path(
    app: AppHandle,
    state: tauri::State<AgentState>,
    preset: String,
    path: String,
) -> Result<(), String> {
    state.init(&app);
    state.set_path(&preset, &path)
}

/// 이 탭의 실행을 취소한다. 실행 중이 아니면 아무 일도 하지 않는다.
#[tauri::command]
pub fn cancel_agent(window: tauri::WebviewWindow, state: tauri::State<AgentState>, path: String) {
    state.cancel(&run_key(window.label(), &path));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// 가짜 CLI. 인자를 무시하고 cwd의 사본을 고친다.
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn scratch(tag: &str) -> WorkDir {
        let w = WorkDir::create().unwrap();
        let _ = tag;
        w
    }

    fn quiet() -> Arc<dyn Fn(Stream, String) + Send + Sync> {
        Arc::new(|_, _| {})
    }

    fn inv() -> impl FnOnce(&Path) -> Invocation {
        |_| Invocation { args: vec![], env: vec![] }
    }

    // ---- 프리셋과 인자 ----

    #[test]
    fn agent_presets_are_the_three_fixed_names() {
        let ids: Vec<_> = PRESETS.iter().map(|p| (p.id, p.bin)).collect();
        assert_eq!(ids, [("claude", "claude"), ("codex", "codex"), ("opencode", "opencode")]);
    }

    #[test]
    fn agent_invocation_ends_with_prompt_and_never_asks_for_full_access() {
        let dir = Path::new("/tmp/mv-x");
        for p in PRESETS.iter() {
            let inv = build_invocation(p.id, "PROMPT", dir, None).unwrap();
            assert_eq!(inv.args.last().map(String::as_str), Some("PROMPT"), "{}", p.id);
            for a in &inv.args {
                for bad in ["dangerously", "yolo", "danger-full-access", "bypass", "skip-permissions"] {
                    assert!(!a.contains(bad), "{}: {a}", p.id);
                }
                assert_ne!(a, "--auto", "{}", p.id);
            }
        }
        assert!(build_invocation("sh", "x", dir, None).is_none());
    }

    #[test]
    fn agent_invocation_pins_each_cli_to_the_workdir_or_its_edit_tools() {
        let dir = Path::new("/tmp/mv-x");
        let args = |id: &str| build_invocation(id, "P", dir, None).unwrap().args.join(" ");
        assert!(args("claude").contains("--tools Read,Edit,Write"));
        assert!(args("claude").contains("--permission-prompts none"));
        assert!(args("codex").contains("--sandbox workspace-write"));
        assert!(args("codex").contains("-C /tmp/mv-x"));
        assert!(args("opencode").contains("--dir /tmp/mv-x"));
        let env = build_invocation("opencode", "P", dir, None).unwrap().env;
        assert!(env.iter().any(|(k, v)| k == "OPENCODE_CONFIG_CONTENT" && v.contains(r#""bash":"deny""#)));
    }

    #[test]
    fn agent_prompt_starts_with_fixed_text_so_it_never_looks_like_an_option() {
        assert!(!build_prompt("--yolo").starts_with('-'));
        assert!(build_prompt("번역해 줘").contains("번역해 줘"));
        assert!(build_prompt("x").contains(FILE_NAME));
    }

    // ---- 탐색 ----

    #[test]
    fn agent_parse_marked_path_ignores_noise_around_the_markers() {
        assert_eq!(parse_marked_path("zsh noise\n__MV_PATH__/a:/b__MV_END__tail").as_deref(), Some("/a:/b"));
        assert_eq!(parse_marked_path("no markers"), None);
        assert_eq!(parse_marked_path("__MV_PATH__never closed"), None);
    }

    #[test]
    fn agent_login_shell_path_reads_the_marked_path_from_a_fake_shell() {
        let w = scratch("shell");
        let sh = script(&w.0, "fakesh", "echo noise from rc file\nprintf '__MV_PATH__/x/bin:/y/bin__MV_END__'");
        assert_eq!(login_shell_path(&sh, Duration::from_secs(5)).as_deref(), Some("/x/bin:/y/bin"));
    }

    #[test]
    fn agent_login_shell_path_gives_up_when_the_shell_hangs() {
        let w = scratch("hang");
        let sh = script(&w.0, "slowsh", "sleep 30");
        let t = Instant::now();
        assert_eq!(login_shell_path(&sh, Duration::from_millis(300)), None);
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn agent_login_shell_path_reads_real_zsh_without_stopping_on_tty() {
        let path = login_shell_path(Path::new("/bin/zsh"), SHELL_TIMEOUT).expect("zsh -ilc PATH");
        assert!(!path.is_empty());
        assert_eq!(effective_path(Some("/a".into()), Some("/b".into())), "/a:/b");
        assert_eq!(effective_path(None, Some("/b".into())), "/b");
        assert_eq!(effective_path(Some(String::new()), Some("/b".into())), "/b");
        assert_eq!(effective_path(Some("/a".into()), None), "/a");
    }

    #[test]
    fn agent_find_in_path_returns_only_executables_and_none_when_missing() {
        let w = scratch("find");
        script(&w.0, "claude", "true");
        std::fs::write(w.0.join("codex"), "not executable").unwrap();
        let path = format!("/nonexistent:{}", w.0.display());
        assert_eq!(find_in_path("claude", &path), Some(w.0.join("claude")));
        assert_eq!(find_in_path("codex", &path), None);
        assert_eq!(find_in_path("opencode", &path), None);
        let cache = detect(path, &Overrides::new());
        assert_eq!(cache.found.get("claude"), Some(&w.0.join("claude")));
        assert!(cache.found.get("opencode").is_none());
        assert!(cache.found.get("gemini").is_none(), "Gemini CLI는 프리셋이 아니다");
    }

    #[test]
    fn agent_manual_path_accepts_only_a_matching_executable_name() {
        let w = scratch("manual");
        let good = script(&w.0, "codex", "true");
        let other = script(&w.0, "mytool", "true");
        assert_eq!(validate_manual_path("codex", good.to_str().unwrap()), Ok(good.clone()));
        assert!(validate_manual_path("claude", good.to_str().unwrap()).is_err(), "다른 프리셋 이름");
        assert!(validate_manual_path("codex", other.to_str().unwrap()).is_err(), "다른 파일 이름");
        assert!(validate_manual_path("codex", "/bin/sh").is_err(), "/bin/sh");
        assert!(validate_manual_path("codex", "codex").is_err(), "상대 경로");
        assert!(validate_manual_path("codex", w.0.join("missing/codex").to_str().unwrap()).is_err(), "없는 파일");
        assert!(validate_manual_path("codex", w.0.to_str().unwrap()).is_err(), "디렉터리");
        assert!(validate_manual_path("nope", good.to_str().unwrap()).is_err(), "알 수 없는 프리셋");
    }

    // ---- 실행 ----

    #[test]
    fn agent_run_returns_the_edited_copy_and_leaves_the_original_alone() {
        let w = scratch("run");
        let original = w.0.join("original.md");
        std::fs::write(&original, "원본\n").unwrap();
        let cli = script(&w.0, "fakecli", "printf '수정됨\\n' >> document.md\necho 작업 끝\necho 경고 >&2");
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        let out = run_in_workdir(
            &cli,
            None,
            inv(),
            "원본\n",
            &AtomicBool::new(false),
            Duration::from_secs(10),
            Arc::new(move |_, l| sink.lock().unwrap().push(l)),
        );
        assert_eq!(out, Ok("원본\n수정됨\n".to_string()));
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "원본\n");
        let mut got = lines.lock().unwrap().clone();
        got.sort();
        assert_eq!(got, ["경고", "작업 끝"]);
    }

    #[test]
    fn agent_run_removes_its_temp_folder_on_success_and_failure() {
        let w = scratch("cleanup");
        let seen = Arc::new(Mutex::new(PathBuf::new()));
        let s = seen.clone();
        let cli = script(&w.0, "fakecli", "true");
        // 인자 구성 클로저가 받은 폴더가 실행이 끝난 뒤 사라졌는지 본다.
        let ok = run_in_workdir(&cli, None, move |d| { *s.lock().unwrap() = d.to_path_buf(); Invocation { args: vec![], env: vec![] } }, "x", &AtomicBool::new(false), Duration::from_secs(10), quiet());
        assert!(ok.is_ok());
        let dir = seen.lock().unwrap().clone();
        assert!(dir.starts_with(std::env::temp_dir()));
        assert!(!dir.exists(), "성공 뒤에도 임시 폴더가 남았다");

        let w2 = scratch("cleanup-fail");
        let fail = script(&w2.0, "failcli", "exit 3");
        let s2 = Arc::new(Mutex::new(PathBuf::new()));
        let s2c = s2.clone();
        let err = run_in_workdir(&fail, None, move |d| { *s2c.lock().unwrap() = d.to_path_buf(); Invocation { args: vec![], env: vec![] } }, "x", &AtomicBool::new(false), Duration::from_secs(10), quiet());
        assert!(matches!(err, Err(AgentError::Failed(_))));
        assert!(!s2.lock().unwrap().exists(), "실패 뒤에도 임시 폴더가 남았다");
    }

    #[test]
    fn agent_run_passes_prompt_args_and_env_to_the_program() {
        let w = scratch("args");
        let cli = script(&w.0, "fakecli", "printf '%s|%s' \"$1\" \"$MV_X\" > document.md");
        let out = run_in_workdir(
            &cli,
            None,
            |_| Invocation { args: vec!["--flag".into()], env: vec![("MV_X".into(), "v".into())] },
            "",
            &AtomicBool::new(false),
            Duration::from_secs(10),
            quiet(),
        );
        assert_eq!(out, Ok("--flag|v".to_string()));
    }

    #[test]
    fn agent_run_reports_a_missing_copy_and_non_utf8_results() {
        let w = scratch("badout");
        let rm = script(&w.0, "rmcli", "rm document.md");
        assert!(matches!(
            run_in_workdir(&rm, None, inv(), "x", &AtomicBool::new(false), Duration::from_secs(10), quiet()),
            Err(AgentError::Failed(_))
        ));
        let bin = script(&w.0, "bincli", "printf '\\377\\376' > document.md");
        assert!(matches!(
            run_in_workdir(&bin, None, inv(), "x", &AtomicBool::new(false), Duration::from_secs(10), quiet()),
            Err(AgentError::Failed(_))
        ));
        let big = "a".repeat(MAX_BYTES + 1);
        assert!(matches!(
            run_in_workdir(&rm, None, inv(), &big, &AtomicBool::new(false), Duration::from_secs(10), quiet()),
            Err(AgentError::Failed(_))
        ));
    }

    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn agent_cancel_kills_the_process_group_and_cleans_up() {
        let w = scratch("cancel");
        // 자손(sleep)까지 만든 뒤 오래 기다린다. 두 pid를 모두 알린다.
        let cli = script(&w.0, "slowcli", "sleep 60 &\necho \"pid:$$\"\necho \"child:$!\"\nwait");
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel::<String>();
        let tx = Mutex::new(tx);
        let flag = cancel.clone();
        let seen = Arc::new(Mutex::new(PathBuf::new()));
        let seen2 = seen.clone();
        let handle = std::thread::spawn(move || {
            run_in_workdir(
                &cli,
                None,
                move |d| { *seen2.lock().unwrap() = d.to_path_buf(); Invocation { args: vec![], env: vec![] } },
                "x",
                &flag,
                Duration::from_secs(60),
                Arc::new(move |_, l| { let _ = tx.lock().unwrap().send(l); }),
            )
        });
        let mut pids = vec![];
        while pids.len() < 2 {
            let l = rx.recv_timeout(Duration::from_secs(10)).expect("pid 줄");
            if let Some(n) = l.strip_prefix("pid:").or_else(|| l.strip_prefix("child:")) {
                pids.push(n.parse::<i32>().unwrap());
            }
        }
        assert!(pids.iter().all(|p| alive(*p)));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(handle.join().unwrap(), Err(AgentError::Cancelled));
        // 고아가 된 자손은 init이 거두기 전까지 잠깐 보일 수 있다.
        let deadline = Instant::now() + Duration::from_secs(3);
        while pids.iter().any(|p| alive(*p)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(pids.iter().all(|p| !alive(*p)), "취소 뒤에도 프로세스가 남았다: {pids:?}");
        assert!(!seen.lock().unwrap().exists());
    }

    #[test]
    fn agent_timeout_kills_the_process_and_reports_it() {
        let w = scratch("timeout");
        let cli = script(&w.0, "slowcli", "sleep 60");
        let t = Instant::now();
        let out = run_in_workdir(&cli, None, inv(), "x", &AtomicBool::new(false), Duration::from_millis(400), quiet());
        assert_eq!(out, Err(AgentError::TimedOut));
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    /// 실제 CLI로 한 번씩 왕복하는 실기기 확인. 요금과 시간이 들어서 기본 실행에서는 빠진다:
    /// `cargo test --manifest-path src-tauri/Cargo.toml agent_real -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn agent_real_cli_roundtrip() {
        let cache = detect(login_shell_path(&user_shell(), SHELL_TIMEOUT).unwrap_or_default(), &Overrides::new());
        let mut report = vec![];
        for p in PRESETS.iter() {
            let Some(program) = cache.found.get(p.id) else {
                report.push(format!("{}: 못 찾음", p.id));
                continue;
            };
            let t = Instant::now();
            let prompt = build_prompt("문서 맨 끝에 `- 확인용 줄` 한 줄을 덧붙여 줘.");
            let out = run_in_workdir(
                program,
                Some(cache.shell_path.as_str()),
                |d| build_invocation(p.id, &prompt, d, None).unwrap(),
                "# 제목\n\n본문\n",
                &AtomicBool::new(false),
                Duration::from_secs(300),
                {
                    let id = p.id;
                    Arc::new(move |stream, l| match progress::interpret(id, matches!(stream, Stream::Out), &l) {
                        Parsed::Events(events) => events.iter().for_each(|e| eprintln!("    [{}] {}", e.kind, e.text)),
                        Parsed::Raw(text) => eprintln!("    [raw] {text}"),
                        Parsed::Skip => {}
                    })
                },
            );
            let verdict = match &out {
                Ok(t) if t.contains("확인용 줄") && t.starts_with("# 제목") => "OK".to_string(),
                Ok(t) => format!("수정이 기대와 다름: {t:?}"),
                Err(e) => format!("실패: {}", e.message()),
            };
            report.push(format!("{}: {verdict} ({}s) → {}", p.id, t.elapsed().as_secs(), program.display()));
        }
        eprintln!("\n== 실기기 결과 ==\n{}", report.join("\n"));
        assert!(report.iter().all(|r| r.contains(": OK") || r.contains("못 찾음")), "일부 CLI가 실패했다");
    }

    // ---- 수동 경로 저장 ----

    #[test]
    fn agent_manual_path_is_saved_and_restored_after_restart() {
        let w = scratch("persist");
        let codex = script(&w.0, "codex", "true");
        let file = w.0.join("cfg").join("agent-paths.json");

        let first = AgentState::default();
        first.use_config_file(file.clone());
        assert_eq!(first.set_path("codex", codex.to_str().unwrap()), Ok(()));
        assert!(file.exists());

        // 앱을 다시 켠 것처럼 새 상태가 같은 파일을 읽는다.
        let second = AgentState::default();
        second.use_config_file(file.clone());
        assert_eq!(second.overrides.lock().unwrap().get("codex"), Some(&codex));
        let cache = detect("/nonexistent".into(), &second.overrides.lock().unwrap());
        assert_eq!(cache.found.get("codex"), Some(&codex), "PATH에 없어도 수동 경로를 쓴다");
    }

    #[test]
    fn agent_manual_path_beats_path_lookup_and_empty_clears_it() {
        let w = scratch("beats");
        let on_path = script(&w.0, "claude", "true");
        let other_dir = w.0.join("other");
        std::fs::create_dir(&other_dir).unwrap();
        let manual = script(&other_dir, "claude", "true");
        let st = AgentState::default();
        st.use_config_file(w.0.join("p.json"));
        // 셸 PATH를 읽은 상태를 흉내 낸다.
        *st.cache.lock().unwrap() = Some(detect(w.0.to_string_lossy().into_owned(), &Overrides::new()));
        assert_eq!(st.cache(false).found.get("claude"), Some(&on_path));
        st.set_path("claude", manual.to_str().unwrap()).unwrap();
        assert_eq!(st.cache(false).found.get("claude"), Some(&manual), "수동 경로가 이긴다");
        st.set_path("claude", "").unwrap();
        assert_eq!(st.cache(false).found.get("claude"), Some(&on_path), "지우면 PATH로 돌아간다");
        assert!(st.overrides.lock().unwrap().is_empty());
    }

    #[test]
    fn agent_rejected_manual_path_changes_nothing_on_disk_or_in_memory() {
        let w = scratch("reject");
        let good = script(&w.0, "codex", "true");
        let wrong_name = script(&w.0, "mytool", "true");
        let file = w.0.join("p.json");
        let st = AgentState::default();
        st.use_config_file(file.clone());
        st.set_path("codex", good.to_str().unwrap()).unwrap();
        let saved = std::fs::read_to_string(&file).unwrap();
        for (preset, path) in [
            ("codex", wrong_name.to_str().unwrap()),
            ("codex", "/bin/sh"),
            ("codex", "codex"),
            ("codex", w.0.to_str().unwrap()),
            ("codex", w.0.join("missing/codex").to_str().unwrap()),
            ("claude", good.to_str().unwrap()),
            ("nope", good.to_str().unwrap()),
        ] {
            assert!(st.set_path(preset, path).is_err(), "{preset} {path}");
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), saved);
        assert_eq!(st.overrides.lock().unwrap().get("codex"), Some(&good));
    }

    #[test]
    fn agent_load_overrides_drops_stale_unknown_and_broken_entries() {
        let w = scratch("load");
        let good = script(&w.0, "opencode", "true");
        let file = w.0.join("p.json");
        let json = format!(
            r#"{{"opencode":"{}","claude":"/gone/claude","unknown":"/bin/sh","codex":"/bin/sh"}}"#,
            good.display()
        );
        std::fs::write(&file, json).unwrap();
        let loaded = load_overrides(&file);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.get("opencode"), Some(&good));
        std::fs::write(&file, "{ not json").unwrap();
        assert!(load_overrides(&file).is_empty());
        assert!(load_overrides(&w.0.join("none.json")).is_empty());
    }

    // ---- 프로바이더 설정 ----

    #[test]
    fn agent_provider_model_flag_per_cli() {
        let dir = Path::new("/tmp/mv-x");
        let args = |id: &str, model: Option<&str>| build_invocation(id, "PROMPT", dir, model).unwrap().args;
        // 모델이 있으면 CLI마다 정해진 인자가 프롬프트 앞에 들어가고, 마지막 인자는 여전히 프롬프트다.
        for (id, flag) in [("claude", "--model"), ("codex", "-m"), ("opencode", "-m")] {
            let with = args(id, Some("MODEL"));
            let at = with.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{id}에 {flag}가 없다: {with:?}"));
            assert_eq!(with[at + 1], "MODEL", "{id}");
            assert_eq!(with.iter().filter(|a| a.as_str() == "MODEL").count(), 1, "{id}: 모델은 한 번만");
            assert_eq!(with.last().map(String::as_str), Some("PROMPT"), "{id}: 프롬프트가 마지막이어야 한다");
            assert!(at + 1 < with.len() - 1, "{id}: 모델이 프롬프트 앞이어야 한다");
            // 모델이 없으면 인자를 더하지 않는다 — 모델을 넣고 뺀 것의 차이가 정확히 두 개다.
            let without = args(id, None);
            assert_eq!(with.len(), without.len() + 2, "{id}");
            let mut stripped = with.clone();
            stripped.drain(at..at + 2);
            assert_eq!(stripped, without, "{id}: 모델 두 인자를 빼면 모델 없는 인자와 같아야 한다");
        }
    }

    #[test]
    fn agent_progress_invocations_ask_for_streaming_json() {
        let dir = Path::new("/tmp/mv-x");
        let joined = |id: &str| build_invocation(id, "PROMPT", dir, None).unwrap().args.join(" ");
        assert!(joined("claude").contains("--output-format stream-json --verbose"), "stream-json은 --verbose가 있어야 한다");
        assert!(joined("codex").contains("exec --json"));
        assert!(joined("opencode").contains("run --format json"));
        // 프롬프트는 여전히 마지막 인자다(스트리밍 옵션이 그 뒤로 가면 CLI가 프롬프트로 읽는다).
        for id in ["claude", "codex", "opencode"] {
            assert_eq!(build_invocation(id, "PROMPT", dir, None).unwrap().args.last().map(String::as_str), Some("PROMPT"), "{id}");
        }
    }

    #[test]
    fn agent_provider_disabled_blocks_run() {
        let w = scratch("disabled");
        let st = AgentState::default();
        st.use_providers_file(w.0.join("p.json"));
        assert!(st.ensure_enabled("claude").is_ok(), "기본은 켜짐");
        st.set_provider("claude", Some(false), None).unwrap();
        assert!(st.ensure_enabled("claude").unwrap_err().contains("꺼져"));
        assert!(st.ensure_enabled("codex").is_ok(), "다른 프로바이더는 그대로");
        // 모델만 바꿔도 활성 여부는 유지된다.
        st.set_provider("claude", None, Some("haiku")).unwrap();
        assert!(st.ensure_enabled("claude").is_err());
        assert_eq!(st.provider("claude").model.as_deref(), Some("haiku"));
        st.set_provider("claude", Some(true), None).unwrap();
        assert!(st.ensure_enabled("claude").is_ok());
        assert_eq!(st.provider("claude").model.as_deref(), Some("haiku"), "켜도 모델은 남는다");
    }

    #[test]
    fn agent_provider_settings_persist_and_reject_without_side_effects() {
        let w = scratch("providers");
        let file = w.0.join("cfg").join("agent-providers.json");
        let first = AgentState::default();
        first.use_providers_file(file.clone());
        first.set_provider("codex", Some(false), Some("gpt-x")).unwrap();
        let saved = std::fs::read_to_string(&file).unwrap();

        // 거부는 메모리도 파일도 바꾸지 않는다.
        for (id, enabled, model) in [("codex", None, Some("--yolo")), ("codex", Some(true), Some("a b")), ("nope", Some(true), None)] {
            assert!(first.set_provider(id, enabled, model).is_err(), "{id} {model:?}");
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), saved);
        assert!(!first.provider("codex").enabled, "거부된 요청의 enabled가 반영되면 안 된다");

        // 앱을 다시 켠 것처럼 새 상태가 같은 파일을 읽는다.
        let second = AgentState::default();
        second.use_providers_file(file);
        assert_eq!(second.provider("codex"), ProviderSetting { enabled: false, model: Some("gpt-x".into()) });
        assert_eq!(second.provider("claude"), ProviderSetting::default());
        // 모델을 빈 문자열로 지우면 지정이 없어진다.
        second.set_provider("codex", None, Some("")).unwrap();
        assert_eq!(second.provider("codex").model, None);
    }

    #[test]
    fn agent_provider_test_reports_failure() {
        let w = scratch("probe");
        let ok = script(&w.0, "okcli", "printf -- '- 연결 확인\\n' >> document.md");
        let r = probe_provider("claude", &ok, None, |_| Invocation { args: vec![], env: vec![] }, Duration::from_secs(10));
        assert!(r.as_ref().is_ok_and(|m| m.starts_with("OK")), "{r:?}");

        // 실패하면 CLI가 마지막으로 낸 줄이 이유로 붙는다.
        let login = script(&w.0, "logincli", "echo 'starting' >&2\necho '로그인이 필요합니다' >&2\nexit 1");
        let e = probe_provider("claude", &login, None, |_| Invocation { args: vec![], env: vec![] }, Duration::from_secs(10)).unwrap_err();
        assert!(e.contains("로그인이 필요합니다"), "{e}");

        // 문서를 고치지 않은 성공도 성공이 아니다.
        let lazy = script(&w.0, "lazycli", "true");
        assert!(probe_provider("claude", &lazy, None, |_| Invocation { args: vec![], env: vec![] }, Duration::from_secs(10)).is_err());

        // 오래 걸리면 중단하고 시간 초과를 알린다.
        let slow = script(&w.0, "slowcli", "sleep 30");
        let t = Instant::now();
        let e = probe_provider("claude", &slow, None, |_| Invocation { args: vec![], env: vec![] }, Duration::from_millis(300)).unwrap_err();
        assert!(e.contains("끝나지 않아"), "{e}");
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    /// 실제 CLI에 모델을 지정해 한 번씩 왕복한다. 요금과 시간이 들어서 기본 실행에서는 빠진다:
    /// `cargo test --manifest-path src-tauri/Cargo.toml agent_real_model -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn agent_real_model_flag_roundtrip() {
        let cache = detect(login_shell_path(&user_shell(), SHELL_TIMEOUT).unwrap_or_default(), &Overrides::new());
        let path_env = Some(cache.shell_path.as_str());
        let codex_model = std::fs::read_to_string(std::env::var("HOME").map(|h| format!("{h}/.codex/config.toml")).unwrap_or_default())
            .ok()
            .and_then(|t| t.lines().find_map(|l| l.trim().strip_prefix("model = \"").and_then(|r| r.strip_suffix('"')).map(str::to_string)));
        let opencode_model = cache.found.get("opencode").and_then(|bin| {
            let out = Command::new(bin).arg("models").env("PATH", cache.shell_path.as_str()).output().ok()?;
            String::from_utf8_lossy(&out.stdout).lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
        });
        let models: [(&str, Option<String>); 3] = [("claude", Some("haiku".into())), ("codex", codex_model), ("opencode", opencode_model)];
        let mut report = vec![];
        for (id, model) in models {
            let (Some(program), Some(model)) = (cache.found.get(id), model) else {
                report.push(format!("{id}: 모델이나 실행 파일을 정하지 못함"));
                continue;
            };
            let prompt = build_prompt(PROBE_INSTRUCTION);
            let verdict = match probe_provider(id, program, path_env, |d| build_invocation(id, &prompt, d, Some(&model)).unwrap(), Duration::from_secs(300)) {
                Ok(m) => format!("OK {m}"),
                Err(e) => format!("실패: {e}"),
            };
            report.push(format!("{id}: {verdict} (model={model})"));
        }
        eprintln!("\n== 모델 지정 실기기 결과 ==\n{}", report.join("\n"));
        assert!(report.iter().all(|r| r.contains(": OK ")), "일부가 실패했다");
    }

    // ---- 요청 검증과 중복 실행 방지 ----

    #[test]
    fn agent_request_rejects_unknown_presets_and_bad_prompts() {
        assert!(validate_request("claude", "번역해 줘").is_ok());
        assert!(validate_request("/bin/sh", "x").is_err(), "경로는 프리셋 id가 아니다");
        assert!(validate_request("Claude", "x").is_err(), "대소문자까지 정확히");
        assert!(validate_request("claude", "  \n").is_err(), "빈 지시문");
        assert!(validate_request("claude", &"가".repeat(MAX_PROMPT_BYTES)).is_err(), "너무 긴 지시문");
    }

    #[test]
    fn agent_state_allows_one_run_per_window_and_tab() {
        let st = AgentState::default();
        let a = run_key("main", "/docs/a.md");
        assert!(st.begin(&a).is_some());
        assert!(st.begin(&a).is_none(), "같은 키 두 번째 실행");
        assert!(st.begin(&run_key("main", "/docs/b.md")).is_some(), "다른 탭");
        assert!(st.begin(&run_key("w2", "/docs/a.md")).is_some(), "다른 창");
        st.end(&a);
        assert!(st.begin(&a).is_some(), "끝난 뒤에는 다시 가능");
    }

    #[test]
    fn agent_state_cancel_flags_only_the_matching_run() {
        let st = AgentState::default();
        let a = run_key("main", "/docs/a.md");
        let b = run_key("main", "/docs/b.md");
        let fa = st.begin(&a).unwrap();
        let fb = st.begin(&b).unwrap();
        st.cancel(&a);
        assert!(fa.load(Ordering::SeqCst));
        assert!(!fb.load(Ordering::SeqCst));
        st.cancel(&run_key("main", "/none.md")); // 없는 키는 무시
    }
}
