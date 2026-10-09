#!/usr/bin/env bash
# DMG를 빌드해 GitHub 릴리스(v<버전>)로 공개하고, 자체 Homebrew tap(gyuha/homebrew-tap)의 Cask도 새 버전으로 갱신한다.
# 버전은 src-tauri/tauri.conf.json에서 읽는다. (macOS arm64 전용, gh 로그인 필요)
#
# 사용: scripts/release.sh publish
#   1. 비공개 초안(draft) 릴리스에 DMG를 올린다(태그는 아직 없다).
#   2. 초안을 공개한다(그때 태그 v<버전>이 만들어진다). 공개는 되돌릴 수 없다.
#   3. node scripts/update-tap.mjs <버전> 으로 tap의 Cask를 갱신한다.
#
# 환경 변수(시험용): DRY_RUN=1 이면 빌드와 GitHub·tap을 바꾸는 명령은 출력만 한다. VERSION_OVERRIDE=<버전> 이면 그 버전으로 올린다.
set -euo pipefail

[[ "${1:-}" == "publish" ]] || { echo "사용: $0 publish" >&2; exit 2; }
[[ "$(uname -s)" == "Darwin" ]] || { echo "release는 macOS만 지원합니다" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh(GitHub CLI)가 필요합니다" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="${VERSION_OVERRIDE:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)}"
TAG="v$VERSION"
DMG="src-tauri/target/release/bundle/dmg/markview_${VERSION}_aarch64.dmg"

run() { if [[ "${DRY_RUN:-}" == "1" ]]; then echo "[DRY_RUN] $*"; else "$@"; fi; }

# 태그로 릴리스를 찾는다(초안은 태그가 없어도 목록에는 나온다). 출력: "id<TAB>draft"
release_info() {
  gh api "repos/{owner}/{repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name==\"$TAG\") | [.id, .draft] | @tsv" | head -1
}

# DRY_RUN은 GitHub를 바꾸지 않으므로 저장소 상태 검사와 빌드는 건너뛴다(스크립트를 고치는 중에도 흐름을 시험할 수 있다).
if [[ "${DRY_RUN:-}" != "1" ]]; then
  git fetch -q origin main
  SHA="$(git rev-parse HEAD)"
  [[ "$(git branch --show-current)" == "main" ]] || { echo "main 브랜치에서만 릴리스합니다" >&2; exit 1; }
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "커밋하지 않은 변경이 있습니다" >&2; exit 1; }
  [[ "$SHA" == "$(git rev-parse origin/main)" ]] || { echo "origin/main과 다릅니다 (push 또는 pull 먼저)" >&2; exit 1; }
  INFO="$(release_info || true)"
  if [[ -n "$INFO" ]] && [[ "$(cut -f2 <<<"$INFO")" != "true" ]]; then
    echo "$TAG 는 이미 공개된 릴리스입니다. tauri.conf.json·package.json·Cargo.toml의 버전을 올리세요" >&2
    exit 1
  fi
  pnpm tauri build --bundles dmg
  [[ -f "$DMG" ]] || { echo "DMG가 없습니다: $DMG" >&2; exit 1; }
else
  SHA="<sha>"; INFO=""
fi

if [[ -z "$INFO" ]]; then
  # 대상 커밋을 main이 아니라 빌드한 커밋으로 고정한다(공개할 때 태그가 그 커밋에 붙는다).
  run gh release create "$TAG" "$DMG" --draft --target "$SHA" --title "markview $VERSION" --generate-notes
else
  run gh release upload "$TAG" "$DMG" --clobber
fi

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "[DRY_RUN] gh api -X PATCH repos/{owner}/{repo}/releases/<id> -F draft=false"
else
  gh api -X PATCH "repos/{owner}/{repo}/releases/$(release_info | cut -f1)" -F draft=false --jq '.html_url'
fi
echo "${DRY_RUN:+[DRY_RUN] }배포 완료: $TAG"

# 공개했으니 tap의 Cask도 갱신한다. 릴리스는 이미 공개됐으므로 tap 갱신이 실패해도 되돌리지 않는다.
# 안내를 보여 주고 따로 종료 코드 4로 끝낸다.
if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "[DRY_RUN] node scripts/update-tap.mjs $VERSION   (tap에 push)"
elif ! node scripts/update-tap.mjs "$VERSION"; then
  echo "릴리스는 공개됐지만 Homebrew tap 갱신에 실패했습니다. 확인 후 다시: node scripts/update-tap.mjs $VERSION" >&2
  exit 4
fi
