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

/// 창이 포커스를 받은 순서 — 앞이 가장 최근. 가장 앞이 "최근 포커스 창"이고, 병합 대상 판정에서
/// 겹친 창의 앞뒤를 가르는 근사(Tauri에 z-order API가 없다)로도 쓴다.
#[derive(Default)]
pub struct LastFocus(Mutex<Vec<String>>);

impl LastFocus {
    pub fn set(&self, label: &str) {
        let mut order = self.0.lock().unwrap();
        order.retain(|l| l != label);
        order.insert(0, label.to_string());
    }

    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().first().cloned()
    }

    pub fn order(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

/// 프론트엔드가 시작 때 알린 탭바 높이(논리 픽셀). 0이면 아직 모르는 것이라 병합하지 않는다.
#[derive(Default)]
pub struct TabbarHeight(Mutex<f64>);

impl TabbarHeight {
    pub fn set(&self, height: f64) {
        *self.0.lock().unwrap() = height;
    }

    pub fn get(&self) -> f64 {
        *self.0.lock().unwrap()
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

/// 화면에서 본 창 하나 — 바깥 위치·크기는 물리 픽셀(`outer_position`/`outer_size`), 스케일은 물리/논리 비.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowRect {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// 논리 화면 좌표 `point`가 놓인 가장 앞의 창과, 그 창 바깥 왼쪽 위 기준 논리 좌표를 낸다.
/// Tauri에 z-order API가 없어 겹치면 `focus_order`(최근 포커스가 앞)로 근사하고, 거기 없는 창은 맨 뒤다.
pub fn window_at(
    point: (f64, f64),
    windows: &[WindowRect],
    focus_order: &[String],
) -> Option<(String, (f64, f64))> {
    // 물리 → 논리: 위치·크기를 각 창 스케일로 나눠 포인터 이벤트의 논리 좌표와 맞춘다.
    let rank = |label: &str| focus_order.iter().position(|l| l == label).unwrap_or(usize::MAX);
    windows
        .iter()
        .filter_map(|w| {
            let (x, y) = (w.x / w.scale, w.y / w.scale);
            let (dx, dy) = (point.0 - x, point.1 - y);
            (dx >= 0.0 && dy >= 0.0 && dx < w.width / w.scale && dy < w.height / w.scale)
                .then(|| (rank(&w.label), w.label.clone(), (dx, dy)))
        })
        .min_by_key(|(rank, ..)| *rank)
        .map(|(_, label, inner)| (label, inner))
}

/// 창 안쪽 y(논리)가 탭바 띠 `[0, tabbar_height)` 안인지.
pub fn in_tabbar_band(inner_y: f64, tabbar_height: f64) -> bool {
    inner_y >= 0.0 && inner_y < tabbar_height
}

/// `detach_tab`의 결과 — 프론트엔드는 어느 쪽이든 원 탭을 닫는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetachOutcome {
    Merged,
    Detached,
}

/// 놓은 위치로 정한 분리 방식.
#[derive(Debug, PartialEq, Eq)]
pub enum DetachPlan {
    /// 다른 창 탭바 띠 위 — 그 창(라벨)으로 병합한다.
    Merge(String),
    /// 그 밖(다른 창 본문, 빈 곳, 원 창 자신 포함) — 그 위치에 새 창을 만든다.
    NewWindow,
}

/// 논리 화면 좌표 `point`에 놓았을 때 병합할지 새 창을 만들지 정한다.
/// 가장 앞 창이 원 창이 아니고 그 창의 탭바 띠 안일 때만 병합이다. 탭바 높이를 모르면(0) 병합하지 않는다.
pub fn plan_detach(
    from: &str,
    point: (f64, f64),
    windows: &[WindowRect],
    focus_order: &[String],
    tabbar_height: f64,
) -> DetachPlan {
    match window_at(point, windows, focus_order) {
        Some((label, (_, y))) if label != from && tabbar_height > 0.0 && in_tabbar_band(y, tabbar_height) => {
            DetachPlan::Merge(label)
        }
        _ => DetachPlan::NewWindow,
    }
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

    fn rect(label: &str, x: f64, y: f64, w: f64, h: f64, scale: f64) -> WindowRect {
        WindowRect { label: label.into(), x, y, width: w, height: h, scale }
    }

    #[test]
    fn 병합_어떤_창_밖이면_없다() {
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0)];
        assert_eq!(window_at((900.0, 100.0), &ws, &alive(&["main"])), None);
    }

    #[test]
    fn 병합_창_안이면_그_창과_창_안_위치를_낸다() {
        let ws = [rect("main", 100.0, 50.0, 800.0, 600.0, 1.0)];
        assert_eq!(
            window_at((130.0, 80.0), &ws, &alive(&["main"])),
            Some(("main".to_string(), (30.0, 30.0)))
        );
    }

    #[test]
    fn 병합_겹친_창은_최근_포커스가_앞선다() {
        let ws = [
            rect("main", 0.0, 0.0, 800.0, 600.0, 1.0),
            rect("w2", 100.0, 100.0, 800.0, 600.0, 1.0),
        ];
        let got = window_at((200.0, 200.0), &ws, &alive(&["w2", "main"]));
        assert_eq!(got.map(|g| g.0), Some("w2".to_string()));
        let got = window_at((200.0, 200.0), &ws, &alive(&["main", "w2"]));
        assert_eq!(got.map(|g| g.0), Some("main".to_string()));
    }

    #[test]
    fn 병합_포커스_순서에_없는_창은_있는_창보다_뒤다() {
        let ws = [
            rect("main", 0.0, 0.0, 800.0, 600.0, 1.0),
            rect("w2", 0.0, 0.0, 800.0, 600.0, 1.0),
        ];
        let got = window_at((10.0, 10.0), &ws, &alive(&["w2"]));
        assert_eq!(got.map(|g| g.0), Some("w2".to_string()));
    }

    #[test]
    fn 병합_가려진_창이라도_겹치지_않는_곳은_그_창이_잡힌다() {
        let ws = [
            rect("main", 0.0, 0.0, 400.0, 300.0, 1.0),
            rect("w2", 300.0, 0.0, 400.0, 300.0, 1.0),
        ];
        let got = window_at((100.0, 100.0), &ws, &alive(&["w2", "main"]));
        assert_eq!(got.map(|g| g.0), Some("main".to_string()));
    }

    #[test]
    fn 병합_스케일_인자를_물리_픽셀에_반영한다() {
        // 물리 (200,100) 크기 1600x1200, 스케일 2 → 논리 (100,50) 크기 800x600.
        let ws = [rect("main", 200.0, 100.0, 1600.0, 1200.0, 2.0)];
        assert_eq!(
            window_at((130.0, 80.0), &ws, &alive(&["main"])),
            Some(("main".to_string(), (30.0, 30.0)))
        );
        // 스케일을 안 곱했다면 안쪽이지만 논리로는 창 왼쪽 밖이다.
        assert_eq!(window_at((150.0, 40.0), &ws, &alive(&["main"])), None);
    }

    #[test]
    fn 병합_창_경계는_왼쪽_위를_포함하고_오른쪽_아래를_제외한다() {
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0)];
        let a = alive(&["main"]);
        assert!(window_at((0.0, 0.0), &ws, &a).is_some());
        assert!(window_at((799.9, 599.9), &ws, &a).is_some());
        assert_eq!(window_at((800.0, 300.0), &ws, &a), None);
        assert_eq!(window_at((400.0, 600.0), &ws, &a), None);
        assert_eq!(window_at((-0.1, 300.0), &ws, &a), None);
    }

    #[test]
    fn 병합_탭바_띠_안은_참이고_밖은_거짓이다() {
        assert!(in_tabbar_band(10.0, 36.0));
        assert!(!in_tabbar_band(100.0, 36.0));
        assert!(!in_tabbar_band(-1.0, 36.0));
    }

    #[test]
    fn 병합_탭바_띠_경계는_위를_포함하고_아래를_제외한다() {
        assert!(in_tabbar_band(0.0, 36.0));
        assert!(in_tabbar_band(35.9, 36.0));
        assert!(!in_tabbar_band(36.0, 36.0));
        assert!(!in_tabbar_band(0.0, 0.0));
    }

    #[test]
    fn 병합_다른_창_탭바_띠_위면_그_창으로_병합한다() {
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0), rect("w2", 900.0, 0.0, 800.0, 600.0, 1.0)];
        let plan = plan_detach("main", (950.0, 10.0), &ws, &alive(&["w2", "main"]), 36.0);
        assert_eq!(plan, DetachPlan::Merge("w2".into()));
    }

    #[test]
    fn 병합_다른_창_본문_위면_새_창으로_분리한다() {
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0), rect("w2", 900.0, 0.0, 800.0, 600.0, 1.0)];
        let plan = plan_detach("main", (950.0, 200.0), &ws, &alive(&["w2", "main"]), 36.0);
        assert_eq!(plan, DetachPlan::NewWindow);
    }

    #[test]
    fn 병합_아무_창도_없는_곳이면_새_창으로_분리한다() {
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0)];
        assert_eq!(plan_detach("main", (2000.0, 10.0), &ws, &alive(&["main"]), 36.0), DetachPlan::NewWindow);
    }

    #[test]
    fn 병합_원_창_자신의_탭바_위는_병합이_아니다() {
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0)];
        assert_eq!(plan_detach("main", (100.0, 10.0), &ws, &alive(&["main"]), 36.0), DetachPlan::NewWindow);
    }

    #[test]
    fn 병합_탭바_높이를_아직_모르면_병합하지_않는다() {
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0), rect("w2", 900.0, 0.0, 800.0, 600.0, 1.0)];
        assert_eq!(plan_detach("main", (950.0, 10.0), &ws, &alive(&["w2", "main"]), 0.0), DetachPlan::NewWindow);
    }

    #[test]
    fn 병합_겹친_창에서는_최근_포커스_창이_대상이다() {
        // 원 창이 뒤, w2가 앞 — 겹친 곳의 탭바 띠는 앞에 있는 w2 것이다.
        let ws = [rect("main", 0.0, 0.0, 800.0, 600.0, 1.0), rect("w2", 400.0, 0.0, 800.0, 600.0, 1.0)];
        assert_eq!(plan_detach("w3", (500.0, 10.0), &ws, &alive(&["w2", "main"]), 36.0), DetachPlan::Merge("w2".into()));
    }

    #[test]
    fn 병합_소유권은_원_창에서_대상_창으로_옮겨진다() {
        let w = WindowFiles::default();
        w.claim("main", &p("/a.md"));
        assert!(w.transfer("main", "w2", &p("/a.md")));
        assert_eq!(w.claim("main", &p("/a.md")), Claim::OtherWindow("w2".into()));
        // 대상 창의 다른 탭 소유는 건드리지 않는다.
        w.claim("w2", &p("/b.md"));
        assert_eq!(w.claim("main", &p("/b.md")), Claim::OtherWindow("w2".into()));
    }

    #[test]
    fn 병합_원_창이_쥐지_않은_파일은_병합해도_소유가_바뀌지_않는다() {
        let w = WindowFiles::default();
        w.claim("w3", &p("/a.md"));
        assert!(!w.transfer("main", "w2", &p("/a.md")));
        assert_eq!(w.claim("w2", &p("/a.md")), Claim::OtherWindow("w3".into()));
    }

    #[test]
    fn 병합_탭바_높이는_알린_값을_돌려준다() {
        let h = TabbarHeight::default();
        assert_eq!(h.get(), 0.0);
        h.set(36.0);
        assert_eq!(h.get(), 36.0);
    }

    #[test]
    fn 병합_포커스_순서는_최근이_앞이고_중복이_없다() {
        let f = LastFocus::default();
        f.set("main");
        f.set("w2");
        f.set("main");
        assert_eq!(f.order(), alive(&["main", "w2"]));
        assert_eq!(f.get(), Some("main".to_string()));
    }
}
