#!/usr/bin/env node
// 릴리스 노트를 만든다. 이 저장소에는 CHANGELOG.md가 없어서, 이전 릴리스 태그부터 지금(HEAD)까지의 커밋 제목을 쓴다.
// release.sh가 부른다: GitHub 릴리스 본문(--repo)과 latest.json의 notes(--plain)로 쓴다.
//
//   node scripts/release-notes.mjs <버전> [--repo owner/name]   릴리스 본문(변경 사항 + 전체 비교 링크 + 업데이트 안내)
//   node scripts/release-notes.mjs <버전> --plain               변경 사항 목록만(latest.json의 notes용)
//   node scripts/release-notes.mjs <버전> --since <태그>        이전 태그를 직접 지정한다
// 변경 사항이 하나도 없으면 오류로 끝난다(아직 아무것도 올리지 않은 때에 멈추려는 것이다).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const semver = (tag) => tag.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
const cmp = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** 태그 목록에서 `version` 바로 앞 릴리스 태그. 없으면 null(첫 릴리스). 같은 버전의 태그는 건너뛴다. */
export function previousTag(tags, version) {
  const target = `v${version}`;
  return (
    tags
      .filter((t) => /^v\d+(\.\d+)*$/.test(t) && t !== target && cmp(t, target) < 0)
      .sort(cmp)
      .at(-1) ?? null
  );
}

/** 릴리스 노트에 쓸 커밋 제목: `Release …` 커밋과 빈 제목을 뺀다. */
export function changeList(subjects) {
  return subjects.map((s) => s.trim()).filter((s) => s && !/^Release v?\d/i.test(s));
}

/** 변경 사항 목록(일반 텍스트). 비어 있으면 던진다. */
export function plainNotes(subjects) {
  const list = changeList(subjects);
  if (list.length === 0) throw new Error("이전 릴리스 이후 변경 사항(커밋)이 없습니다");
  return list.map((s) => `- ${s}`).join("\n");
}

/** GitHub 릴리스 본문. */
export function bodyNotes(subjects, { version, repo, prev }) {
  const lines = ["## 변경 사항", "", plainNotes(subjects)];
  if (repo && prev) lines.push("", `전체 비교: https://github.com/${repo}/compare/${prev}...v${version}`);
  lines.push("", "이미 설치한 앱은 설정 창의 \"환경\" 탭 → 업데이트에서 새로 설치하지 않고 업데이트할 수 있습니다(업데이트 기능이 들어간 버전부터).");
  return lines.join("\n");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function main(argv) {
  const [version, ...rest] = argv;
  if (!version || version.startsWith("--")) throw new Error("사용: release-notes.mjs <버전> [--repo owner/name] [--plain] [--since <태그>]");
  const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
  const prev = opt("--since") ?? previousTag(git("tag", "--list", "v*").split("\n").filter(Boolean), version);
  const range = prev ? `${prev}..HEAD` : "HEAD";
  const subjects = git("log", "--no-merges", "--pretty=%s", range).split("\n");
  console.log(rest.includes("--plain") ? plainNotes(subjects) : bodyNotes(subjects, { version, repo: opt("--repo"), prev }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release-notes: ${e.message}`);
    process.exit(1);
  }
}
