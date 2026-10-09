#!/usr/bin/env node
// 공개된 macOS arm64 릴리스 DMG로 자체 tap의 Cask를 갱신한다. GitHub push는 하지 않는다.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`${name} 값이 필요합니다`);
  return args[index + 1];
}

try {
  const version = option('--version');
  const dmg = option('--dmg');
  const out = option('--out');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`잘못된 버전: ${version}`);
  if (basename(dmg) !== `markview_${version}_aarch64.dmg`) throw new Error('DMG 파일 이름과 버전이 일치하지 않습니다');
  if (basename(out) !== 'markview.rb') throw new Error('출력 파일은 markview.rb여야 합니다');
  const sha256 = createHash('sha256').update(await readFile(dmg)).digest('hex');
  const cask = `cask "markview" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/gyuha/markview/releases/download/v#{version}/markview_#{version}_aarch64.dmg"
  name "markview"
  desc "Markdown 파일 뷰어"
  homepage "https://github.com/gyuha/markview"

  depends_on arch: :arm64

  app "markview.app"

  # 공식 서명·공증을 거치지 않은 앱이다. 이 앱에 한해서만 격리를 해제한다.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/markview.app"]
  end
end
`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, cask);
  console.log(`Cask 갱신: ${out} (${version}, sha256 ${sha256})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
