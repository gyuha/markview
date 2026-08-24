// ⌘B/⌘I 검증. 실제 EditorView가 필요해 브라우저에서 돈다 —
// `pnpm dev` 후 http://localhost:1420/harness/keymap.html 를 열고 #out 을 읽는다.
import { EditorSelection } from "@codemirror/state";
import { createEditor } from "../src/editor";

const host = document.createElement("div");
document.body.appendChild(host);
const view = createEditor(host, "굵게 기울임", "light", () => {});

const out = document.createElement("pre");
out.id = "out";
document.body.appendChild(out);

function press(key: string): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true }),
  );
}
function select(text: string): void {
  const at = view.state.doc.toString().indexOf(text);
  view.dispatch({ selection: EditorSelection.single(at, at + text.length) });
}

const lines: string[] = [];
view.focus();
select("굵게");
press("b");
lines.push(`bold=${view.state.doc.toString()}`);
press("b");
lines.push(`bold2=${view.state.doc.toString()}`);
select("기울임");
press("i");
lines.push(`italic=${view.state.doc.toString()}`);
out.textContent = lines.join("\n");
