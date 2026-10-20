use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// 파일 소유 요청의 결과.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Claim {
    /// 이 창이 소유한다(이미 이 창 것이었던 경우 포함).
    Granted,
    /// 다른 창이 이미 열고 있다. 그 창의 라벨.
    OtherWindow(String),
}

/// 어느 창이 어느 파일을 열고 있는지. 같은 파일을 두 창이 열어 서로 덮어쓰는 일을 막는 단일 출처다.
#[derive(Default)]
pub struct WindowFiles(Mutex<HashMap<PathBuf, String>>);

impl WindowFiles {
    pub fn claim(&self, label: &str, path: &PathBuf) -> Claim {
        let mut map = self.0.lock().unwrap();
        match map.get(path) {
            Some(owner) if owner != label => Claim::OtherWindow(owner.clone()),
            _ => {
                map.insert(path.clone(), label.to_string());
                Claim::Granted
            }
        }
    }

    /// 소유 창만 풀 수 있다 — 다른 창의 release가 남의 소유를 지우지 않는다.
    pub fn release(&self, label: &str, path: &PathBuf) {
        let mut map = self.0.lock().unwrap();
        if map.get(path).is_some_and(|owner| owner == label) {
            map.remove(path);
        }
    }

    /// 분리: 원 창이 쥔 파일의 소유를 새 창으로 옮긴다. 원 창 것이 아니면 옮기지 않고 false.
    pub fn transfer(&self, from: &str, to: &str, path: &PathBuf) -> bool {
        let mut map = self.0.lock().unwrap();
        if map.get(path).is_some_and(|owner| owner == from) {
            map.insert(path.clone(), to.to_string());
            true
        } else {
            false
        }
    }

    /// 창이 닫힐 때 그 창이 쥔 파일을 전부 푼다.
    pub fn release_all(&self, label: &str) {
        self.0.lock().unwrap().retain(|_, owner| owner != label);
    }
}

/// 새 창 라벨 할당기. `w2`, `w3`… 단조 증가라 닫힌 창의 라벨을 다시 쓰지 않는다 —
/// 라벨은 window-state 저장값과 창 세션의 키이므로 재사용하면 남의 위치·세션을 물려받는다.
pub struct WindowLabels(AtomicU32);

impl Default for WindowLabels {
    fn default() -> Self {
        // `main`이 1번이므로 2부터.
        Self(AtomicU32::new(2))
    }
}

impl WindowLabels {
    pub fn alloc(&self, alive: &[String]) -> String {
        loop {
            let label = format!("w{}", self.0.fetch_add(1, Ordering::SeqCst));
            if !alive.contains(&label) {
                return label;
            }
        }
    }
}

/// 새 창이 시작할 때 열 경로. 창이 뜬 뒤 프론트엔드가 한 번 가져간다.
#[derive(Default)]
pub struct WindowInit(Mutex<HashMap<String, String>>);

impl WindowInit {
    pub fn set(&self, label: &str, path: String) {
        self.0.lock().unwrap().insert(label.to_string(), path);
    }

    pub fn take(&self, label: &str) -> Option<String> {
        self.0.lock().unwrap().remove(label)
    }
}

/// 메뉴·외부 열기를 받을 창을 고른다. 지금 포커스된 창 → 가장 최근 포커스 창 순이고,
/// 둘 다 이미 닫혔으면(살아 있는 라벨에 없으면) 없음.
pub fn pick_target(
    focused: Option<&str>,
    last_focused: Option<&str>,
    alive: &[String],
) -> Option<String> {
    [focused, last_focused]
        .into_iter()
        .flatten()
        .find(|l| alive.iter().any(|a| a == l))
        .map(str::to_string)
}

/// 가장 최근에 포커스를 받은 창의 라벨.
#[derive(Default)]
pub struct LastFocus(Mutex<Option<String>>);

impl LastFocus {
    pub fn set(&self, label: &str) {
        *self.0.lock().unwrap() = Some(label.to_string());
    }

    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

/// 창 닫기를 한 번 통과시키는 플래그를 창 라벨별로 둔다.
/// 한 창의 통과 플래그가 다른 창의 닫기 요청을 소비하면 그 창이 확인 없이 닫힌다.
#[derive(Default)]
pub struct CloseGuard(Mutex<HashSet<String>>);

impl CloseGuard {
    pub fn allow(&self, label: &str) {
        self.0.lock().unwrap().insert(label.to_string());
    }

    /// 이 창의 플래그가 서 있었으면 내리고 true.
    pub fn take(&self, label: &str) -> bool {
        self.0.lock().unwrap().remove(label)
    }
}

/// 저장된 창 세션 하나 — 되살릴 창의 라벨과 그 창이 시작할 때 열 경로.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct RestoreEntry {
    pub label: String,
    pub path: String,
}

/// 시작 때 실제로 만들 창만 고른다. main은 이미 있고, 살아 있는 라벨·빈 경로·중복 라벨은 건너뛴다.
pub fn restore_targets(entries: &[RestoreEntry], alive: &[String]) -> Vec<RestoreEntry> {
    let mut seen: HashSet<&str> = HashSet::new();
    entries
        .iter()
        .filter(|e| {
            e.label != "main"
                && !e.path.is_empty()
                && !alive.contains(&e.label)
                && seen.insert(e.label.as_str())
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn alive(labels: &[&str]) -> Vec<String> {
        labels.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 다중창_메뉴는_포커스_창이_받는다() {
        let a = alive(&["main", "w2"]);
        assert_eq!(pick_target(Some("w2"), Some("main"), &a), Some("w2".to_string()));
    }

    #[test]
    fn 다중창_포커스가_없으면_가장_최근_포커스_창이_받는다() {
        let a = alive(&["main", "w2"]);
        assert_eq!(pick_target(None, Some("w2"), &a), Some("w2".to_string()));
    }

    #[test]
    fn 다중창_최근_포커스_창이_닫혔으면_대상이_없다() {
        let a = alive(&["main"]);
        assert_eq!(pick_target(None, Some("w2"), &a), None);
        assert_eq!(pick_target(Some("w3"), None, &a), None);
        assert_eq!(pick_target(None, None, &a), None);
    }

    #[test]
    fn 다중창_닫기_통과는_한_번만_소비된다() {
        let g = CloseGuard::default();
        g.allow("main");
        assert!(g.take("main"));
        assert!(!g.take("main"));
    }

    #[test]
    fn 다중창_한_창의_통과_플래그는_다른_창_닫기에_영향이_없다() {
        let g = CloseGuard::default();
        g.allow("main");
        assert!(!g.take("w2"));
        assert!(g.take("main"));
    }

    #[test]
    fn 다중창_새_라벨은_살아_있는_라벨과_겹치지_않는다() {
        let l = WindowLabels::default();
        let alive = vec!["main".to_string(), "w2".to_string(), "w3".to_string()];
        assert_eq!(l.alloc(&alive), "w4");
    }

    #[test]
    fn 다중창_새_라벨은_닫힌_라벨도_다시_쓰지_않고_단조_증가한다() {
        let l = WindowLabels::default();
        assert_eq!(l.alloc(&["main".to_string()]), "w2");
        // w2가 닫혀 목록에서 빠져도 다음은 w3이다.
        assert_eq!(l.alloc(&["main".to_string()]), "w3");
    }

    #[test]
    fn 다중창_이미_살아_있는_라벨은_건너뛴다() {
        let l = WindowLabels::default();
        let alive = vec!["main".to_string(), "w2".to_string()];
        assert_eq!(l.alloc(&alive), "w3");
        assert_eq!(l.alloc(&alive), "w4");
    }

    #[test]
    fn 다중창_시작_경로는_한_번만_소비된다() {
        let i = WindowInit::default();
        i.set("w2", "/a.md".into());
        assert_eq!(i.take("w2"), Some("/a.md".to_string()));
        assert_eq!(i.take("w2"), None);
    }

    #[test]
    fn 다중창_시작_경로는_라벨별로_따로_보관된다() {
        let i = WindowInit::default();
        i.set("w2", "/a.md".into());
        i.set("w3", "/b.md".into());
        assert_eq!(i.take("w3"), Some("/b.md".to_string()));
        assert_eq!(i.take("main"), None);
        assert_eq!(i.take("w2"), Some("/a.md".to_string()));
    }

    #[test]
    fn 다중창_소유권_이전은_원_창_것을_새_창으로_옮긴다() {
        let w = WindowFiles::default();
        w.claim("main", &p("/a.md"));
        assert!(w.transfer("main", "w2", &p("/a.md")));
        assert_eq!(w.claim("main", &p("/a.md")), Claim::OtherWindow("w2".into()));
        assert_eq!(w.claim("w2", &p("/a.md")), Claim::Granted);
    }

    #[test]
    fn 다중창_원_창이_소유하지_않은_파일은_이전하지_않는다() {
        let w = WindowFiles::default();
        w.claim("w3", &p("/a.md"));
        assert!(!w.transfer("main", "w2", &p("/a.md")));
        assert_eq!(w.claim("w2", &p("/a.md")), Claim::OtherWindow("w3".into()));
    }


    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn 다중창_소유_없는_파일은_요청하면_성공한다() {
        let w = WindowFiles::default();
        assert_eq!(w.claim("main", &p("/a.md")), Claim::Granted);
    }

    #[test]
    fn 다중창_같은_창이_다시_요청해도_성공한다() {
        let w = WindowFiles::default();
        w.claim("main", &p("/a.md"));
        assert_eq!(w.claim("main", &p("/a.md")), Claim::Granted);
    }

    #[test]
    fn 다중창_다른_창이_소유한_파일은_거절하고_소유_창을_알린다() {
        let w = WindowFiles::default();
        w.claim("main", &p("/a.md"));
        assert_eq!(w.claim("w2", &p("/a.md")), Claim::OtherWindow("main".into()));
    }

    #[test]
    fn 다중창_release_뒤에는_다른_창이_요청해도_성공한다() {
        let w = WindowFiles::default();
        w.claim("main", &p("/a.md"));
        w.release("main", &p("/a.md"));
        assert_eq!(w.claim("w2", &p("/a.md")), Claim::Granted);
    }

    #[test]
    fn 다중창_남의_소유_파일은_release해도_풀리지_않는다() {
        let w = WindowFiles::default();
        w.claim("main", &p("/a.md"));
        w.release("w2", &p("/a.md"));
        assert_eq!(w.claim("w2", &p("/a.md")), Claim::OtherWindow("main".into()));
    }

    #[test]
    fn 다중창_창이_닫히면_그_창_소유만_모두_풀린다() {
        let w = WindowFiles::default();
        w.claim("main", &p("/a.md"));
        w.claim("main", &p("/b.md"));
        w.claim("w2", &p("/c.md"));
        w.release_all("main");
        assert_eq!(w.claim("w2", &p("/a.md")), Claim::Granted);
        assert_eq!(w.claim("w2", &p("/b.md")), Claim::Granted);
        assert_eq!(w.claim("main", &p("/c.md")), Claim::OtherWindow("w2".into()));
    }

    fn entry(label: &str, path: &str) -> RestoreEntry {
        RestoreEntry { label: label.into(), path: path.into() }
    }

    #[test]
    fn 다중창_복원은_main이_아닌_항목만_만든다() {
        let got = restore_targets(&[entry("main", "/a.md"), entry("w2", "/b.md")], &alive(&["main"]));
        assert_eq!(got, vec![entry("w2", "/b.md")]);
    }

    #[test]
    fn 다중창_복원은_이미_살아_있는_라벨과_빈_경로를_건너뛴다() {
        let got = restore_targets(
            &[entry("w2", "/b.md"), entry("w3", ""), entry("w4", "/d.md")],
            &alive(&["main", "w2"]),
        );
        assert_eq!(got, vec![entry("w4", "/d.md")]);
    }

    #[test]
    fn 다중창_복원은_같은_라벨이_두_번_와도_한_번만_만든다() {
        let got = restore_targets(&[entry("w2", "/b.md"), entry("w2", "/c.md")], &alive(&["main"]));
        assert_eq!(got, vec![entry("w2", "/b.md")]);
    }
}
