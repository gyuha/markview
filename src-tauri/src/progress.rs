//! CLI의 스트리밍 JSON 출력을 사람이 읽을 진행 단계로 바꾼다.
//!
//! Paseo가 provider마다 다른 이벤트를 하나의 타임라인(상태·생각·도구 호출·메시지·오류)으로 정규화하는 것과 같은 생각이다.
//! 여기서는 일회성 실행이라 세션·권한 요청은 없고, 화면에 보일 한 줄(`kind` + `text`)만 만든다.
//! 알 수 없는 이벤트와 훅 같은 잡음은 버리고(`Skip`), JSON이 아닌 줄은 그대로 둔다(`Raw`).
//! 문서 내용·임시 폴더 경로·도구 입력은 화면에 싣지 않는다 — 단계 이름만 보인다.

use serde::Serialize;
use serde_json::Value;

/// 화면에 보일 한 단계. `kind`는 status · thinking · tool · message · warning · error 중 하나다.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Progress {
    pub kind: &'static str,
    pub text: String,
}

#[derive(Debug, PartialEq)]
pub enum Parsed {
    /// 해석한 단계들(한 줄이 여러 단계일 수 있다).
    Events(Vec<Progress>),
    /// 해석할 수 없는 일반 줄 — 원문 그대로 보인다.
    Raw(String),
    /// 보일 것이 없다(빈 줄, 훅·메타 이벤트).
    Skip,
}

const MAX_TEXT_CHARS: usize = 300;
const MAX_COMMAND_CHARS: usize = 80;

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max).collect::<String>())
}

fn p(kind: &'static str, text: impl Into<String>) -> Progress {
    Progress { kind, text: text.into() }
}

/// 한 줄을 해석한다. JSON 스트림은 표준 출력에만 있다 — 표준 오류는 항상 원문이다.
pub fn interpret(preset: &str, from_stdout: bool, line: &str) -> Parsed {
    let line = line.trim_end();
    if line.trim().is_empty() {
        return Parsed::Skip;
    }
    // codex가 표준 입력을 닫아 둔 것을 알리는 한 줄 — 화면에 보일 가치가 없다.
    if line.trim() == "Reading additional input from stdin..." {
        return Parsed::Skip;
    }
    if !from_stdout || !line.trim_start().starts_with('{') {
        return Parsed::Raw(line.to_string());
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Parsed::Raw(line.to_string()) };
    let events = match preset {
        "claude" => claude(&v),
        "codex" => codex(&v),
        "opencode" => opencode(&v),
        _ => vec![],
    };
    if events.is_empty() {
        Parsed::Skip
    } else {
        Parsed::Events(events)
    }
}

fn tool_label(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "read" => "문서를 읽는 중".into(),
        "edit" | "write" | "multiedit" | "patch" => "문서를 고치는 중".into(),
        "glob" | "grep" | "list" | "ls" => "파일을 찾는 중".into(),
        _ => format!("도구 사용: {}", cut(name, 40)),
    }
}

fn claude(v: &Value) -> Vec<Progress> {
    match v["type"].as_str() {
        Some("system") => match v["subtype"].as_str() {
            Some("init") => vec![p("status", "에이전트를 시작했습니다")],
            Some("status") if v["status"] == "requesting" => vec![p("status", "모델에 요청하는 중")],
            _ => vec![],
        },
        Some("assistant") => v["message"]["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| match b["type"].as_str() {
                        Some("thinking") => Some(p("thinking", "생각하는 중")),
                        Some("text") => b["text"].as_str().filter(|t| !t.trim().is_empty()).map(|t| p("message", cut(t, MAX_TEXT_CHARS))),
                        Some("tool_use") => Some(p("tool", tool_label(b["name"].as_str().unwrap_or("")))),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("user") => v["message"]["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"] == "tool_result" && b["is_error"] == true)
                    .map(|b| p("warning", format!("도구 오류: {}", cut(b["content"].as_str().unwrap_or(""), MAX_COMMAND_CHARS))))
                    .collect()
            })
            .unwrap_or_default(),
        Some("result") => {
            if v["is_error"] == true {
                let why = v["result"].as_str().or(v["subtype"].as_str()).unwrap_or("오류로 끝났습니다");
                vec![p("error", cut(why, MAX_TEXT_CHARS))]
            } else {
                // 정상 종료는 앱이 "완료"로 표시한다 — 같은 말을 두 번 보이지 않는다.
                vec![]
            }
        }
        _ => vec![],
    }
}

/// 셸 래퍼(`/bin/zsh -lc '…'`)를 벗겨 명령만 남긴다.
fn short_command(command: &str) -> String {
    let inner = command.split_once(" -lc ").map(|(_, rest)| rest).unwrap_or(command);
    // 여러 줄 명령(here-doc 등)은 첫 줄만 보인다.
    let first = inner.trim().trim_matches('\'').trim_matches('"').lines().next().unwrap_or("");
    cut(first, MAX_COMMAND_CHARS)
}

fn codex(v: &Value) -> Vec<Progress> {
    let item = &v["item"];
    match v["type"].as_str() {
        Some("thread.started") => vec![p("status", "에이전트를 시작했습니다")],
        Some("turn.started") => vec![p("thinking", "생각하는 중")],
        Some("turn.completed") => vec![],
        Some("turn.failed") | Some("error") => {
            let why = v["error"]["message"].as_str().or(v["message"].as_str()).unwrap_or("오류로 끝났습니다");
            vec![p("error", cut(why, MAX_TEXT_CHARS))]
        }
        Some("item.started") => match item["type"].as_str() {
            Some("command_execution") => vec![p("tool", format!("명령 실행: {}", short_command(item["command"].as_str().unwrap_or(""))))],
            Some("file_change") => vec![p("tool", "문서를 고치는 중")],
            _ => vec![],
        },
        Some("item.completed") => match item["type"].as_str() {
            Some("agent_message") => item["text"].as_str().filter(|t| !t.trim().is_empty()).map(|t| vec![p("message", cut(t, MAX_TEXT_CHARS))]).unwrap_or_default(),
            Some("reasoning") => vec![p("thinking", "생각하는 중")],
            // 설정 파일 경고 같은 것 — 실행을 막는 오류가 아니므로 첫 줄만 경고로 둔다.
            Some("error") => vec![p("warning", cut(item["message"].as_str().unwrap_or("").lines().next().unwrap_or(""), MAX_COMMAND_CHARS * 2))],
            Some("command_execution") if item["exit_code"].as_i64().is_some_and(|c| c != 0) => {
                vec![p("warning", format!("명령이 실패했습니다(종료 코드 {})", item["exit_code"]))]
            }
            _ => vec![],
        },
        _ => vec![],
    }
}

fn opencode(v: &Value) -> Vec<Progress> {
    let part = &v["part"];
    match v["type"].as_str() {
        Some("step_start") => vec![p("thinking", "생각하는 중")],
        Some("tool_use") => match part["state"]["status"].as_str() {
            Some("error") => vec![p("warning", format!("도구 오류: {}", cut(part["state"]["error"].as_str().or(part["state"]["output"].as_str()).unwrap_or(""), MAX_COMMAND_CHARS)))],
            _ => vec![p("tool", tool_label(part["tool"].as_str().unwrap_or("")))],
        },
        Some("text") => part["text"].as_str().filter(|t| !t.trim().is_empty()).map(|t| vec![p("message", cut(t, MAX_TEXT_CHARS))]).unwrap_or_default(),
        Some("error") => {
            let why = v["error"]["data"]["message"].as_str().or(v["error"]["message"].as_str()).or(v["error"]["name"].as_str()).unwrap_or("오류로 끝났습니다");
            vec![p("error", cut(why, MAX_TEXT_CHARS))]
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(preset: &str, line: &str) -> Vec<(String, String)> {
        match interpret(preset, true, line) {
            Parsed::Events(list) => list.into_iter().map(|e| (e.kind.to_string(), e.text)).collect(),
            other => panic!("이벤트가 아니다: {other:?}"),
        }
    }
    fn one(kind: &str, text: &str) -> Vec<(String, String)> {
        vec![(kind.to_string(), text.to_string())]
    }

    // 실제 CLI 출력에서 줄여 온 것들이다(이 기기의 claude 2.1.306 · codex 0.159.2 · opencode, 2026-10-24).

    #[test]
    fn agent_progress_claude_steps() {
        assert_eq!(events("claude", r#"{"type":"system","subtype":"init","cwd":"/tmp/x","tools":["Edit","Read"]}"#), one("status", "에이전트를 시작했습니다"));
        assert_eq!(events("claude", r#"{"type":"system","subtype":"status","status":"requesting"}"#), one("status", "모델에 요청하는 중"));
        assert_eq!(
            events("claude", r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"AAAA"}]}}"#),
            one("thinking", "생각하는 중")
        );
        assert_eq!(
            events("claude", r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/private/var/x/document.md"}}]}}"#),
            one("tool", "문서를 읽는 중"),
            "도구 입력(임시 폴더 경로)은 화면에 싣지 않는다"
        );
        assert_eq!(events("claude", r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{}}]}}"#), one("tool", "문서를 고치는 중"));
        assert_eq!(events("claude", r#"{"type":"assistant","message":{"content":[{"type":"text","text":"한 줄을 덧붙였습니다."}]}}"#), one("message", "한 줄을 덧붙였습니다."));
        assert_eq!(interpret("claude", true, r#"{"type":"result","subtype":"success","is_error":false,"result":"끝"}"#), Parsed::Skip, "정상 종료는 앱이 완료로 표시한다");
        assert_eq!(events("claude", r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Not logged in · Please run /login"}"#), one("error", "Not logged in · Please run /login"));
    }

    #[test]
    fn agent_progress_claude_noise_is_skipped_and_multiple_blocks_expand() {
        for noise in [
            r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}"#,
            r#"{"type":"system","subtype":"hook_response","exit_code":0}"#,
            r#"{"type":"system","subtype":"thinking_tokens"}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"something-new"}"#,
        ] {
            assert_eq!(interpret("claude", true, noise), Parsed::Skip, "{noise}");
        }
        assert_eq!(
            events("claude", r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"tool_use","name":"Write","input":{}}]}}"#),
            vec![("thinking".to_string(), "생각하는 중".to_string()), ("tool".to_string(), "문서를 고치는 중".to_string())]
        );
        assert_eq!(
            events("claude", r#"{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"permission denied"}]}}"#),
            one("warning", "도구 오류: permission denied")
        );
    }

    #[test]
    fn agent_progress_codex_steps() {
        assert_eq!(events("codex", r#"{"type":"thread.started","thread_id":"abc"}"#), one("status", "에이전트를 시작했습니다"));
        assert_eq!(events("codex", r#"{"type":"turn.started"}"#), one("thinking", "생각하는 중"));
        assert_eq!(
            events("codex", r#"{"type":"item.started","item":{"id":"i3","type":"command_execution","command":"/bin/zsh -lc 'cat document.md'","status":"in_progress"}}"#),
            one("tool", "명령 실행: cat document.md"),
            "셸 래퍼는 벗긴다"
        );
        assert_eq!(
            events("codex", r#"{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc 'python3 - <<\"PY\"\nprint(1)\nPY'","status":"in_progress"}}"#),
            one("tool", "명령 실행: python3 - <<\"PY\""),
            "여러 줄 명령은 첫 줄만"
        );
        assert_eq!(interpret("codex", false, "Reading additional input from stdin..."), Parsed::Skip);
        assert_eq!(interpret("codex", true, r#"{"type":"item.completed","item":{"type":"command_execution","command":"x","exit_code":0,"status":"completed"}}"#), Parsed::Skip);
        assert_eq!(
            events("codex", r#"{"type":"item.completed","item":{"type":"command_execution","command":"x","exit_code":2,"status":"failed"}}"#),
            one("warning", "명령이 실패했습니다(종료 코드 2)")
        );
        assert_eq!(events("codex", r#"{"type":"item.started","item":{"type":"file_change","changes":[{"path":"/p/document.md","kind":"update"}]}}"#), one("tool", "문서를 고치는 중"));
        assert_eq!(events("codex", r#"{"type":"item.completed","item":{"type":"agent_message","text":"덧붙였습니다.\n"}}"#), one("message", "덧붙였습니다."));
        assert_eq!(
            events("codex", r#"{"type":"item.completed","item":{"type":"error","message":"Codex is ignoring 1 unrecognized configuration setting.\n  user: x"}}"#),
            one("warning", "Codex is ignoring 1 unrecognized configuration setting."),
            "설정 경고는 실행을 막는 오류가 아니다 — 첫 줄만 경고로"
        );
        assert_eq!(interpret("codex", true, r#"{"type":"turn.completed","usage":{"input_tokens":1}}"#), Parsed::Skip);
        assert_eq!(events("codex", r#"{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}"#), one("error", "unexpected status 401 Unauthorized"));
        assert_eq!(events("codex", r#"{"type":"error","message":"stream disconnected"}"#), one("error", "stream disconnected"));
    }

    #[test]
    fn agent_progress_opencode_steps() {
        assert_eq!(events("opencode", r#"{"type":"step_start","part":{"type":"step-start"}}"#), one("thinking", "생각하는 중"));
        assert_eq!(
            events("opencode", r#"{"type":"tool_use","part":{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"/p/document.md"},"output":"1: # t"}}}"#),
            one("tool", "문서를 읽는 중")
        );
        assert_eq!(events("opencode", r#"{"type":"tool_use","part":{"type":"tool","tool":"glob","state":{"status":"completed","input":{"pattern":"**/document.md"}}}}"#), one("tool", "파일을 찾는 중"));
        assert_eq!(events("opencode", r#"{"type":"tool_use","part":{"type":"tool","tool":"edit","state":{"status":"completed"}}}"#), one("tool", "문서를 고치는 중"));
        assert_eq!(events("opencode", r#"{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"error","error":"denied by permission"}}}"#), one("warning", "도구 오류: denied by permission"));
        assert_eq!(events("opencode", r#"{"type":"text","part":{"type":"text","text":"완료. 추가했습니다."}}"#), one("message", "완료. 추가했습니다."));
        assert_eq!(interpret("opencode", true, r#"{"type":"step_finish","part":{"reason":"stop"}}"#), Parsed::Skip);
        assert_eq!(events("opencode", r#"{"type":"error","error":{"name":"APIError","data":{"message":"Unauthorized"}}}"#), one("error", "Unauthorized"));
    }

    #[test]
    fn agent_progress_non_json_and_stderr_stay_raw_and_blank_lines_vanish() {
        assert_eq!(interpret("claude", true, "Warning: something plain"), Parsed::Raw("Warning: something plain".into()));
        assert_eq!(interpret("claude", true, "{ not json"), Parsed::Raw("{ not json".into()));
        // 표준 오류는 JSON처럼 보여도 해석하지 않는다.
        assert_eq!(interpret("claude", false, r#"{"type":"result"}"#), Parsed::Raw(r#"{"type":"result"}"#.into()));
        assert_eq!(interpret("claude", true, "   "), Parsed::Skip);
        assert_eq!(interpret("unknown", true, r#"{"type":"x"}"#), Parsed::Skip);
    }

    #[test]
    fn agent_progress_long_text_is_cut_by_characters_not_bytes() {
        let long = "가".repeat(500);
        let line = format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{long}"}}]}}}}"#);
        let got = events("claude", &line);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1.chars().count(), MAX_TEXT_CHARS + 1, "300자 + 줄임표");
        assert!(got[0].1.ends_with('…'));
    }
}
