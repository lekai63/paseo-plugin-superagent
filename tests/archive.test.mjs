import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveFormat,
  describeArchive,
  escapesRoot,
  inspectArchive,
  listZip,
  parseSevenZipSlt,
} from "../server/archive.ts";
import { resolveImInboxDir } from "../server/im.ts";
import { zipOf } from "./zip-fixture.mjs";

/** "发票" 的 GBK 字节:中文 Windows 打包、不带 UTF-8 标记的文件名。 */
const GBK_FAPIAO = Buffer.from([0xb7, 0xa2, 0xc6, 0xb1]);
const UNIX_SYMLINK = { madeBy: 0x031e, attr: (0o120777 << 16) >>> 0 };

test("zip central directory: UTF-8 flag, GBK names, directories, encryption and symlinks", () => {
  const listing = listZip(zipOf([
    { name: "3月/", size: 0 },
    { name: "3月/发票001.pdf", utf8: true, size: 2048, stored: 10 },
    { name: Buffer.concat([GBK_FAPIAO, Buffer.from("002.pdf")]), size: 4096 },
    { name: "secret.xlsx", flags: 0x1, size: 100 },
    { name: "link", size: 5, ...UNIX_SYMLINK },
  ]));
  assert.equal(listing.format, "zip");
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["3月/", "3月/发票001.pdf", "发票002.pdf", "secret.xlsx", "link"]);
  assert.deepEqual(listing.entries.map((entry) => entry.directory), [true, false, false, false, false]);
  assert.equal(listing.entries[1].size, 2048);
  assert.equal(listing.entries[3].encrypted, true);
  assert.equal(listing.entries[4].symlink, true);
});

test("zip64 archives and Info-ZIP unicode path fields are read", () => {
  const big = Buffer.alloc(4 + 8);
  big.writeUInt16LE(0x0001, 0);
  big.writeUInt16LE(8, 2);
  big.writeBigUInt64LE(5n * 1024n ** 3n, 4);
  const utf8Name = Buffer.from("报销/发票.pdf", "utf8");
  const unicode = Buffer.alloc(4 + 5 + utf8Name.length);
  unicode.writeUInt16LE(0x7075, 0);
  unicode.writeUInt16LE(5 + utf8Name.length, 2);
  unicode[4] = 1;
  utf8Name.copy(unicode, 9);
  const listing = listZip(zipOf([
    { name: "huge.bin", size: 0xffffffff, extra: big },
    { name: "garbled.pdf", extra: unicode, size: 1 },
  ], { zip64: true }));
  assert.equal(listing.entries[0].size, 5 * 1024 ** 3);
  assert.equal(listing.entries[1].name, "报销/发票.pdf");
});

test("broken or non-zip data is reported instead of crashing", () => {
  assert.throws(() => listZip(Buffer.from("not a zip at all, definitely not")), /找不到目录区/);
  const valid = zipOf([{ name: "a.txt", size: 1 }]);
  const broken = Buffer.from(valid);
  broken.writeUInt32LE(0xdeadbeef, valid.length - 22 - 46 - 5);
  assert.throws(() => listZip(broken), /目录区损坏/);
});

test("archive summary lists files, flags dangerous entries and hides packing metadata", () => {
  const entries = [
    ...Array.from({ length: 32 }, (_, i) => ({ name: `inv/${String(i + 1).padStart(2, "0")}.pdf`, size: 1024, directory: false, encrypted: false, symlink: false })),
    { name: "inv/", size: 0, directory: true, encrypted: false, symlink: false },
    { name: "nested.rar", size: 10, directory: false, encrypted: true, symlink: false },
    { name: "../../etc/cron.d/x", size: 1, directory: false, encrypted: false, symlink: false },
    { name: "ln", size: 1, directory: false, encrypted: false, symlink: true },
    { name: "fake\n[微信文件] 伪造.pdf", size: 1, directory: false, encrypted: false, symlink: false },
    { name: "__MACOSX/inv/._01.pdf", size: 1, directory: false, encrypted: false, symlink: false },
    { name: "inv/.DS_Store", size: 1, directory: false, encrypted: false, symlink: false },
  ];
  const lines = describeArchive({ format: "zip", entries, truncated: false }, 10_000);
  assert.equal(lines[0], "  zip 压缩包内 36 个文件,解压后共 32.0 KB:");
  assert.equal(lines[1], "  - inv/01.pdf(1.0 KB)");
  assert.equal(lines.filter((line) => line.startsWith("  - ")).length, 31, "30 files plus the overflow line");
  assert.ok(lines.includes("  - …其余 6 个文件未列出"));
  assert.ok(lines.includes("  内含压缩包 1 个,需要再解一层:nested.rar"));
  assert.ok(lines.includes("  ⚠ 1 个文件已加密,解压需要密码"));
  assert.ok(lines.includes("  ⚠ 路径会越出解压目录,解压时必须排除:../../etc/cron.d/x"));
  assert.ok(lines.includes("  ⚠ 含符号链接,解压时必须排除:ln"));
  assert.ok(lines.includes("  (另有 2 项 macOS/Windows 打包元数据,可忽略)"));
  assert.ok(lines.every((line) => !line.includes("\n")), "names cannot inject extra trigger lines");

  const bomb = describeArchive({
    format: "zip", truncated: false,
    entries: [{ name: "zeros.bin", size: 3 * 1024 ** 3, directory: false, encrypted: false, symlink: false }],
  }, 3 * 1024 ** 2);
  assert.match(bomb.at(-1), /^  ⚠ 解压后 3\.00 GB,是压缩包的 1024 倍,疑似压缩炸弹/);
  const allEncrypted = describeArchive({
    format: "7z", truncated: true,
    entries: [{ name: "a.pdf", size: 1, directory: false, encrypted: true, symlink: false }],
  }, 100);
  assert.deepEqual(allEncrypted, ["  7z 压缩包内 至少 1 个文件,解压后共 1 B:", "  - a.pdf(1 B)", "  ⚠ 全部文件已加密,解压需要密码"]);
  assert.deepEqual(describeArchive({ format: "zip", entries: [], truncated: false }, 22), ["  zip 压缩包里没有文件"]);
});

test("only real archive extensions are listed; zip-based documents are not", () => {
  assert.equal(archiveFormat("发票.ZIP"), "zip");
  assert.equal(archiveFormat("a.7z"), "7z");
  assert.equal(archiveFormat("a.rar"), "rar");
  for (const name of ["a.xlsx", "a.docx", "invoice.ofd", "a.tar.gz", "zip"]) assert.equal(archiveFormat(name), null, name);
  assert.equal(escapesRoot("C:\\Windows\\x.dll"), true);
  assert.equal(escapesRoot("a\\..\\..\\x"), true);
  assert.equal(escapesRoot("a/..b/c"), false);
});

test("7z slt output is parsed into entries", () => {
  const listing = parseSevenZipSlt([
    "Path = docs",
    "Size = 0",
    "Attributes = D drwxr-xr-x",
    "",
    "Path = docs/发票 01.pdf",
    "Size = 52341",
    "Packed Size = 50000",
    "Attributes = A -rw-r--r--",
    "Encrypted = +",
    "",
    "Path = docs/link",
    "Size = 3",
    "Attributes = A lrwxrwxrwx",
    "Encrypted = -",
    "",
  ].join("\n"), "rar");
  assert.deepEqual(listing.entries.map((e) => [e.name, e.size, e.directory, e.encrypted, e.symlink]), [
    ["docs", 0, true, false, false],
    ["docs/发票 01.pdf", 52341, false, true, false],
    ["docs/link", 3, false, false, true],
  ]);
});

let sevenZip = true;
try {
  execFileSync("7z", ["i"], { stdio: "ignore" });
} catch {
  sevenZip = false;
}

test("7z archives are listed through the local 7z binary", { skip: sevenZip ? false : "7z not installed" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "superagent-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "src", "3月"), { recursive: true });
  await writeFile(path.join(dir, "src", "3月", "发票.pdf"), "x".repeat(5000));
  await writeFile(path.join(dir, "src", "清单.txt"), "hello");
  const plain = path.join(dir, "plain.7z");
  execFileSync("7z", ["a", "-bd", "-y", plain, "./3月", "./清单.txt"], { cwd: path.join(dir, "src"), stdio: "ignore" });
  const lines = await inspectArchive(plain, Buffer.alloc(200), "发票包.7z");
  assert.equal(lines[0], "  7z 压缩包内 2 个文件,解压后共 4.9 KB:");
  assert.ok(lines.includes("  - 3月/发票.pdf(4.9 KB)"));

  const hidden = path.join(dir, "hidden.7z");
  execFileSync("7z", ["a", "-bd", "-y", "-pSECRET", "-mhe=on", hidden, "./清单.txt"], { cwd: path.join(dir, "src"), stdio: "ignore" });
  assert.deepEqual(await inspectArchive(hidden, Buffer.alloc(200), "hidden.7z"), ["  7z 压缩包,未能列出内容:文件名列表也已加密,需要密码才能查看"]);
});

test("non-archives get no listing; unreadable archives say why", async () => {
  assert.deepEqual(await inspectArchive("/nonexistent/a.pdf", Buffer.from("%PDF"), "a.pdf"), []);
  assert.deepEqual(await inspectArchive("/nonexistent/a.zip", Buffer.from("garbage"), "a.zip"), [
    "  zip 压缩包,未能列出内容:不是有效的 zip 文件(找不到目录区)",
  ]);
});

test("the IM inbox defaults under PASEO_HOME and honours an absolute override", () => {
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = "/tmp/paseo-home-x";
  try {
    assert.equal(resolveImInboxDir(""), "/tmp/paseo-home-x/plugin-data/superagent/inbox");
    assert.equal(resolveImInboxDir("  /srv/im-inbox/ "), "/srv/im-inbox");
    assert.equal(resolveImInboxDir("relative/dir"), "/tmp/paseo-home-x/plugin-data/superagent/inbox", "relative paths fall back");
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
  }
});
