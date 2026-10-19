/**
 * 최근 연 파일 기록과 검색 다이얼로그. 기록은 localStorage에 경로만 최근 순으로 둔다.
 * 확인 대화상자와 같은 `.modal-backdrop`을 써서 전역 단축키 차단(main.ts의 모달 검사)을 그대로 받는다.
 */
const STORAGE_KEY = "markview.recent";
const MAX_RECENT = 20;

export function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** 경로를 맨 앞에 두고 중복을 없앤 뒤 20개까지만 남긴다. */
export function recordRecent(path: string): void {
  const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장소를 못 쓰면 이번 실행 동안만 기록이 없을 뿐이다.
  }
}

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** 공백으로 나눈 단어가 모두 경로(파일명·폴더 포함)에 들어 있으면 남긴다. 대소문자는 구분하지 않는다. */
function filterPaths(paths: string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return paths.filter((p) => {
    const hay = p.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 최근 파일 다이얼로그. 고른 경로를 `open`으로 넘기고, 취소하면 아무것도 부르지 않는다. */
export function openRecentDialog(open: (path: string) => void): void {
  if (document.querySelector(".modal-backdrop")) return;
  const all = readRecent();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const box = document.createElement("div");
  box.className = "modal recent-modal";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "최근 파일");

  const input = document.createElement("input");
  input.type = "search";
  input.className = "recent-search";
  input.placeholder = "최근 파일 검색";
  input.setAttribute("aria-label", "최근 파일 검색");

  const list = document.createElement("div");
  list.className = "recent-list";
  list.setAttribute("role", "listbox");

  box.append(input, list);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);

  let shown: string[] = [];
  let selected = 0;

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const choose = (path: string) => {
    close();
    open(path);
  };

  const paint = () => {
    list.replaceChildren();
    if (shown.length === 0) {
      const empty = document.createElement("p");
      empty.className = "recent-empty";
      empty.textContent = all.length === 0 ? "최근 연 파일이 없습니다" : "일치하는 파일이 없습니다";
      list.appendChild(empty);
      return;
    }
    shown.forEach((path, i) => {
      const { name, dir } = splitPath(path);
      const item = document.createElement("div");
      item.className = "recent-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === selected));
      item.dataset.path = path;
      const nameEl = document.createElement("span");
      nameEl.className = "recent-name";
      nameEl.textContent = name;
      const dirEl = document.createElement("span");
      dirEl.className = "recent-dir";
      dirEl.textContent = dir;
      item.append(nameEl, dirEl);
      item.addEventListener("click", () => choose(path));
      list.appendChild(item);
    });
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  };

  const refilter = () => {
    shown = filterPaths(all, input.value);
    selected = 0;
    paint();
  };

  // 캡처 단계에서 잡아 에디터 키맵보다 먼저 처리한다. 한글 조합 중 Enter는 조합 확정이므로 건드리지 않는다.
  const onKey = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (shown[selected]) choose(shown[selected]);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      selected = (selected + step + shown.length) % shown.length;
      paint();
    }
  };

  input.addEventListener("input", refilter);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey, true);
  refilter();
  input.focus();
}
