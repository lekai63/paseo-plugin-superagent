import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractFileLinks, parseFileTarget } from "../shared/file-links.ts";
import { codeLanguage, excerptLines, fenceCode, fileIconName, FilePreviewSchema } from "../shared/file-preview.ts";
import { expandPath, readFilePreview, statPaths } from "../server/file-preview.ts";
import { setServerLanguage } from "../server/i18n.ts";

// These assertions cover the Chinese daemon text; the English variants live in server-i18n.test.mjs.
setServerLanguage("zh-CN");

test("Router file links become previewable targets with labels and line numbers", () => {
  const text = [
    "已写好 [`report.md`](/srv/work/report.md),入口在 [`main.ts`](/srv/work/src/main.ts:42)。",
    "区间 [范围](/srv/work/src/a.ts#L10-L20) 与目录 [产物](/srv/work/out/)。",
    "编码 [空格](/srv/work/my%20notes.md) 与尖括号 [b](</srv/work/with space.txt>)、[f](file:///srv/work/f.txt)。",
  ].join("\n");
  assert.deepEqual(extractFileLinks(text), [
    { path: "/srv/work/report.md", directory: false, label: "report.md" },
    { path: "/srv/work/src/main.ts", directory: false, lineStart: 42, label: "main.ts" },
    { path: "/srv/work/src/a.ts", directory: false, lineStart: 10, lineEnd: 20, label: "范围" },
    { path: "/srv/work/out", directory: true, label: "产物" },
    { path: "/srv/work/my notes.md", directory: false, label: "空格" },
    { path: "/srv/work/with space.txt", directory: false, label: "b" },
    { path: "/srv/work/f.txt", directory: false, label: "f" },
  ]);
});

test("web links, relative paths, images and links inside code are not file links", () => {
  const text = [
    "[站点](https://example.com/a.md) [相对](docs/a.md) [锚点](#intro) [邮件](mailto:a@b.c)",
    "![图](/srv/work/shot.png)",
    "行内 `[x](/srv/work/inline.md)` 不算。",
    "```md",
    "[y](/srv/work/fenced.md)",
    "```",
    "~~~",
    "[z](/srv/work/tilde.md)",
    "~~~",
    "[留下](/srv/work/kept.md)",
  ].join("\n");
  assert.deepEqual(extractFileLinks(text).map((link) => link.path), ["/srv/work/kept.md"]);
});

test("duplicate links collapse, home paths are kept and the list is capped", () => {
  const text = "[a](/x/a.md) [again](/x/a.md) [line](/x/a.md:3) [home](~/notes/todo.md)";
  assert.deepEqual(extractFileLinks(text).map((link) => [link.path, link.lineStart ?? null]), [
    ["/x/a.md", null], ["/x/a.md", 3], ["~/notes/todo.md", null],
  ]);
  const many = Array.from({ length: 20 }, (_, index) => `[f${index}](/x/f${index}.md)`).join(" ");
  assert.equal(extractFileLinks(many).length, 12);
  assert.equal(parseFileTarget("C:/work/a.ts:7")?.lineStart, 7);
  assert.deepEqual(parseFileTarget("/"), { path: "/", directory: false });
  assert.equal(parseFileTarget("vscode://file/a"), null);
});

test("code fences outgrow backticks in the file and excerpts surround the cited lines", () => {
  assert.equal(fenceCode("a\n```\nb\n", "ts"), "````ts\na\n```\nb\n````");
  assert.equal(codeLanguage("Dockerfile", ""), "dockerfile");
  assert.equal(codeLanguage("a.py", "py"), "python");
  assert.equal(codeLanguage("a.log", "log"), "");
  const text = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const excerpt = excerptLines(text, 100, 105);
  assert.deepEqual({ ...excerpt, text: undefined }, { text: undefined, from: 90, to: 145, total: 200 });
  assert.ok(excerpt.text.startsWith("line 90\n") && excerpt.text.endsWith("line 145"));
  assert.equal(excerptLines("a\nb\n", 1), null, "short files show in full");
  assert.equal(excerptLines(text, 999), null, "lines past the end show the whole file");
});

test("the server reads text, images, directories and refuses what it cannot preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "superagent-preview-"));
  try {
    await writeFile(join(dir, "note.md"), "\uFEFF# 标题\n正文\n");
    await writeFile(join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    await writeFile(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    await writeFile(join(dir, "big.txt"), "中".repeat(100));
    await mkdir(join(dir, "sub"));
    await symlink(join(dir, "missing"), join(dir, "dangling"));

    const note = await readFilePreview(join(dir, "note.md"));
    assert.equal(note.kind, "text");
    assert.equal(note.text, "# 标题\n正文\n");
    assert.equal(note.truncated, false);
    FilePreviewSchema.parse(note);

    const image = await readFilePreview(join(dir, "pic.png"));
    assert.equal(image.kind, "image");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual([...Buffer.from(image.base64, "base64")], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);

    assert.deepEqual(await readFilePreview(join(dir, "blob.bin")).then((value) => [value.kind, value.reason]), ["binary", "binary"]);

    // 截断落在多字节字符中间时退回到完整字符。
    const big = await readFilePreview(join(dir, "big.txt"), { textBytes: 10, imageBytes: 4, entries: 2 });
    assert.equal(big.kind, "text");
    assert.equal(big.truncated, true);
    assert.equal(big.text, "中中中");
    assert.equal(big.size, 300);

    const tooBig = await readFilePreview(join(dir, "pic.png"), { textBytes: 10, imageBytes: 4, entries: 2 });
    assert.deepEqual([tooBig.kind, tooBig.reason], ["binary", "too_large"]);

    const listing = await readFilePreview(dir, { textBytes: 10, imageBytes: 4, entries: 2 });
    assert.equal(listing.kind, "directory");
    assert.equal(listing.total, 6);
    assert.deepEqual(listing.entries, [{ name: "sub", directory: true }, { name: "big.txt", directory: false }]);

    const missing = await readFilePreview(join(dir, "dangling"));
    assert.deepEqual([missing.kind, missing.message], ["error", "文件不存在(可能已被删除或移动)"]);
    assert.equal((await readFilePreview("relative/path.md")).kind, "error");
    assert.equal((await readFilePreview("/dev/null")).kind, "error", "devices are not read");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("home-relative paths expand to the daemon user's home", () => {
  assert.equal(expandPath("~/a/b.md"), join(homedir(), "a/b.md"));
  assert.equal(expandPath("~"), homedir());
  assert.equal(expandPath("/srv/../srv/x"), "/srv/x");
  assert.equal(expandPath("a.md"), null);
  assert.equal(expandPath("/a\0b"), null);
});

test("chips learn whether each linked path is a file, a folder or gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "superagent-stat-"));
  try {
    await writeFile(join(dir, "a.md"), "x");
    await mkdir(join(dir, "pages"));
    await symlink(join(dir, "pages"), join(dir, "link"));
    const paths = [join(dir, "a.md"), join(dir, "pages"), join(dir, "link"), join(dir, "gone.md"), join(dir, "a.md", "x"), "relative", "/dev/null"];
    assert.deepEqual(await statPaths(paths), Object.fromEntries(paths.map((path, index) =>
      [path, ["file", "directory", "directory", "missing", "missing", "unknown", "unknown"][index]])));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chip icons tell folders, missing files and file types apart", () => {
  assert.equal(fileIconName("", "directory"), "Folder");
  assert.equal(fileIconName("md", "guess-directory"), "Folder");
  assert.equal(fileIconName("md", "missing"), "FileX");
  assert.equal(fileIconName("md", "file"), "FileText");
  assert.equal(fileIconName("tsx", "file"), "FileCode");
  assert.equal(fileIconName("json", "unknown"), "FileJson");
  assert.equal(fileIconName("png", "file"), "FileImage");
  assert.equal(fileIconName("sh", "file"), "FileTerminal");
  assert.equal(fileIconName("", "file"), "File");
});
