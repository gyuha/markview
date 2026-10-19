#!/usr/bin/env bash
# DMG와 서명된 업데이트 파일을 빌드해 GitHub 릴리스(v<버전>)로 공개하고, 자체 Homebrew tap(gyuha/homebrew-tap)의 Cask도
# 새 버전으로 갱신한다. 버전은 src-tauri/tauri.conf.json에서 읽는다. (macOS arm64 전용, gh 로그인 필요)
#
# 사용: scripts/release.sh publish
#   1. 비공개 초안(draft) 릴리스에 DMG를 올린다(태그는 아직 없다). 본문은 이전 릴리스 이후 커밋 제목으로 만든다.
#   2. 앱 안 업데이트용 파일을 올린다: 업데이트 압축 파일(.app.tar.gz)과 서명(.sig), 그리고 latest.json.
#      앱은 https://github.com/<저장소>/releases/latest/download/latest.json 을 보므로 **공개하기 전에** 올려 둔다.
#   3. 초안을 공개한다(그때 태그 v<버전>이 만들어진다). 공개는 되돌릴 수 없다.
#   4. node scripts/update-tap.mjs <버전> 으로 tap의 Cask를 갱신한다.
#
# 서명 키: 업데이트 파일은 서명 키로 빌드해야 만들어진다. 환경 변수 TAURI_SIGNING_PRIVATE_KEY(키 파일 경로 또는 내용)가 없으면
# ~/.tauri/markview.key를 쓴다. 둘 다 없으면 빌드 전에 멈춘다. 비밀번호는 TAURI_SIGNING_PRIVATE_KEY_PASSWORD(없으면 빈 값).
#
# SKIP_BUILD=1 이면 빌드·키·브랜치 검사를 건너뛰고 이미 만든 산출물을 올려 공개한다(.github/workflows/release.yml이 쓴다).
# 환경 변수(시험용): DRY_RUN=1 이면 빌드와 GitHub·tap을 바꾸는 명령은 출력만 하고 gh를 한 번도 부르지 않는다(키도 필요 없다).
#   VERSION_OVERRIDE=<버전> 이면 그 버전으로 올린다. RELEASE_WORK_DIR=<폴더> 이면 그 폴더를 작업 폴더로 쓰고 지우지 않는다
#   (만든 latest.json을 볼 수 있다).
set -euo pipefail

[[ "${1:-}" == "publish" ]] || { echo "사용: $0 publish" >&2; exit 2; }
[[ "$(uname -s)" == "Darwin" ]] || { echo "release는 macOS만 지원합니다" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh(GitHub CLI)가 필요합니다" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="${VERSION_OVERRIDE:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -1)}"
TAG="v$VERSION"
BUNDLE_DIR="src-tauri/target/release/bundle"
DMG="$BUNDLE_DIR/dmg/markview_${VERSION}_aarch64.dmg"
# 업데이트 산출물. 올릴 때는 버전이 들어간 이름으로 복사한다(GitHub는 파일 이름의 공백을 바꿔 버린다).
UPD_SRC="$BUNDLE_DIR/macos/markview.app.tar.gz"
UPD_NAME="markview_${VERSION}_aarch64.app.tar.gz"
PLATFORM="darwin-aarch64"

run() { if [[ "${DRY_RUN:-}" == "1" ]]; then echo "[DRY_RUN] $*"; else "$@"; fi; }

# 저장소 이름(owner/name). DRY_RUN에서도 gh 없이 알 수 있도록 git remote에서 읽는다.
REPO="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
[[ "$REPO" =~ ^[^/]+/[^/]+$ ]] || { echo "origin에서 GitHub 저장소 이름을 읽지 못했습니다: $REPO" >&2; exit 1; }

# 작업 폴더. RELEASE_WORK_DIR가 있으면 그것을 쓰고 지우지 않는다.
if [[ -n "${RELEASE_WORK_DIR:-}" ]]; then
  WORK="$RELEASE_WORK_DIR"; mkdir -p "$WORK"
else
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
fi

# 태그로 릴리스를 찾는다(초안은 태그가 없어도 목록에는 나온다). 출력: "id<TAB>draft"
release_info() {
  gh api "repos/{owner}/{repo}/releases?per_page=100" \
    --jq ".[] | select(.tag_name==\"$TAG\") | [.id, .draft] | @tsv" | head -1
}

# 이전 빌드가 남긴 임시 디스크 이미지(rw.*.dmg)가 마운트된 채로 있으면 DMG 만드는 단계가 실패한다(v0.3.0 때 겪었다).
# 이 저장소의 것만 분리하고 지운다 — 다른 프로젝트의 마운트는 건드리지 않는다.
detach_stale_images() {
  local dir="$ROOT/$BUNDLE_DIR/macos" dev
  while read -r dev; do
    [[ -n "$dev" ]] && hdiutil detach -force "$dev" >/dev/null 2>&1 || true
  done < <(hdiutil info 2>/dev/null | awk -v pat="$dir/rw." '
    /^=+$/ { if (hit) for (d in devs) print d; hit = 0; delete devs; next }
    /^image-path/ && index($0, pat) { hit = 1 }
    $1 ~ /^\/dev\/disk[0-9]+$/ { devs[$1] = 1 }
    END { if (hit) for (d in devs) print d }')
  rm -f "$dir"/rw.*.dmg
}

# 릴리스 노트는 빌드 전에 만든다 — 변경 사항이 없으면 아무것도 하기 전에 여기서 멈춘다.
node scripts/release-notes.mjs "$VERSION" --repo "$REPO" >"$WORK/notes.md"
node scripts/release-notes.mjs "$VERSION" --plain >"$WORK/notes.txt"

# DRY_RUN은 GitHub를 바꾸지 않으므로 저장소 상태 검사와 빌드는 건너뛴다(스크립트를 고치는 중에도 흐름을 시험할 수 있다).
if [[ "${DRY_RUN:-}" != "1" && "${SKIP_BUILD:-}" != "1" ]]; then
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
  # 서명 키가 없으면 빌드하기 전에 멈춘다(빌드한 뒤에야 업데이트 파일이 없다는 걸 알게 되면 몇 분을 버린다).
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    if [[ -f "$HOME/.tauri/markview.key" ]]; then
      export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/markview.key"
    else
      echo "서명 키가 없습니다. TAURI_SIGNING_PRIVATE_KEY(키 파일 경로 또는 내용)를 설정하거나 ~/.tauri/markview.key를 만드세요" >&2
      echo "만드는 법: pnpm tauri signer generate -w ~/.tauri/markview.key (DEPLOY.md 참고)" >&2
      exit 1
    fi
  fi
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
  detach_stale_images
  # createUpdaterArtifacts는 이 빌드에서만 켠다 — 평소 pnpm tauri build는 키 없이 된다.
  pnpm tauri build --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":true}}'
  [[ -f "$DMG" ]] || { echo "DMG가 없습니다: $DMG" >&2; exit 1; }
  [[ -f "$UPD_SRC" && -f "$UPD_SRC.sig" ]] || { echo "업데이트 파일이 없습니다: $UPD_SRC(.sig)" >&2; exit 1; }
elif [[ "${SKIP_BUILD:-}" == "1" ]]; then
  # GitHub Actions: 러너가 이미 같은 커밋을 빌드했다. 브랜치·키·빌드 단계는 건너뛰고 산출물만 확인한다.
  SHA="$(git rev-parse HEAD)"
  INFO="$(release_info || true)"
  if [[ -n "$INFO" ]] && [[ "$(cut -f2 <<<"$INFO")" != "true" ]]; then
    echo "$TAG 는 이미 공개된 릴리스입니다. 버전을 올리세요" >&2
    exit 1
  fi
  [[ -f "$DMG" ]] || { echo "DMG가 없습니다: $DMG" >&2; exit 1; }
  [[ -f "$UPD_SRC" && -f "$UPD_SRC.sig" ]] || { echo "업데이트 파일이 없습니다: $UPD_SRC(.sig)" >&2; exit 1; }
else
  SHA="<sha>"; INFO=""
  # 키 없이 흐름만 시험하므로 가짜 산출물로 대신한다.
  echo "[DRY_RUN] 업데이트 산출물이 없어 가짜 파일로 대신합니다 (키 없이 시험 중)"
  UPD_SRC="$WORK/fake.app.tar.gz"; echo fake >"$UPD_SRC"; echo "FAKE-SIGNATURE" >"$UPD_SRC.sig"
fi
cp "$UPD_SRC" "$WORK/$UPD_NAME"
cp "$UPD_SRC.sig" "$WORK/$UPD_NAME.sig"

if [[ -z "$INFO" ]]; then
  # 대상 커밋을 main이 아니라 빌드한 커밋으로 고정한다(공개할 때 태그가 그 커밋에 붙는다).
  run gh release create "$TAG" "$DMG" --draft --target "$SHA" --title "markview $VERSION" --notes-file "$WORK/notes.md"
else
  # 이미 있는 초안의 본문은 건드리지 않는다(사용자가 GitHub에서 고친 노트를 덮어쓰지 않는다).
  run gh release upload "$TAG" "$DMG" --clobber
fi

# 업데이트 파일과 latest.json. 이미 올라온 latest.json(같은 초안을 다시 올리는 경우)이 있으면 그 항목에 병합한다.
if [[ "${DRY_RUN:-}" != "1" ]]; then
  gh release download "$TAG" -p latest.json -D "$WORK" >/dev/null 2>&1 || true
fi
node scripts/update-manifest.mjs --version "$VERSION" --platform "$PLATFORM" \
  --url "https://github.com/$REPO/releases/download/$TAG/$UPD_NAME" --sig-file "$WORK/$UPD_NAME.sig" \
  --notes-file "$WORK/notes.txt" --existing "$WORK/latest.json" --out "$WORK/latest.json"
run gh release upload "$TAG" "$WORK/$UPD_NAME" "$WORK/$UPD_NAME.sig" "$WORK/latest.json" --clobber

# 공개한다. 위에서 latest.json까지 올라가 있어야 공개 즉시 앱이 업데이트를 찾을 수 있다.
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
