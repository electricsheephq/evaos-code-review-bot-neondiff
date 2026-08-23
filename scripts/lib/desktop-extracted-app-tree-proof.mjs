import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PYTHON = "/usr/bin/python3", MAX_ENTRIES = 20_000, MAX_BYTES = 512 * 1024 * 1024, MAX_METADATA = 16 * 1024 * 1024;
const fail = (message) => { throw new Error(message); };
function text(value, label) { if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is malformed`); return value; }
function archivePath(raw) {
  const value = text(raw, "archive entry"), name = value.endsWith("/") ? value.slice(0, -1) : value;
  if (name !== name.normalize("NFC") || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) fail("archive entry is not canonical");
  if (name !== "NeonDiff.app" && !name.startsWith("NeonDiff.app/")) fail("archive contains data outside NeonDiff.app");
  return name;
}
function readBounded(descriptor) {
  const before = fstatSync(descriptor); if (!before.isFile() || before.size > MAX_BYTES) fail("artifact bytes exceed bound");
  const chunks = [], buffer = Buffer.allocUnsafe(1024 * 1024); let total = 0, count;
  do { count = readSync(descriptor, buffer, 0, buffer.length, null); if (count) { total += count; if (total > MAX_BYTES) fail("artifact bytes exceed bound"); chunks.push(Buffer.from(buffer.subarray(0, count))); } } while (count);
  const after = fstatSync(descriptor); if (!after.isFile() || before.size !== after.size || total !== after.size) fail("artifact changed during read");
  return Buffer.concat(chunks, total);
}
function pythonJson(code, artifact) {
  try { return JSON.parse(execFileSync(PYTHON, ["-I", "-c", code, artifact], { encoding: "utf8", maxBuffer: MAX_METADATA })); }
  catch { fail("artifact is not a readable ZIP"); }
}
function preflightArchive(artifact) {
  const listed = pythonJson("import json,sys,unicodedata,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([[i.filename,i.file_size,i.compress_size,(i.external_attr>>16)&0xffff,unicodedata.normalize('NFKC',i.filename.rstrip('/')).casefold()] for i in z.infolist()],separators=(',',':')))", artifact);
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > MAX_ENTRIES) fail("archive entry bound exceeded");
  const seen = new Set(); let expanded = 0, compressed = 0;
  for (const item of listed) {
    if (!Array.isArray(item) || item.length !== 5 || typeof item[4] !== "string" || !Number.isSafeInteger(item[1]) || item[1] < 0 || !Number.isSafeInteger(item[2]) || item[2] < 0 || !Number.isSafeInteger(item[3]) || item[3] < 0) fail("archive metadata is malformed");
    const name = archivePath(item[0]), key = item[4]; if (seen.has(key)) fail("archive entry collision"); seen.add(key);
    expanded += item[1]; compressed += item[2]; if (expanded > MAX_BYTES || compressed > MAX_BYTES) fail("archive byte bound exceeded");
    const kind = item[3] & 0o170000; if (![0, 0o040000, 0o100000, 0o120000].includes(kind)) fail("archive special file type unsupported");
  }
  return listed;
}
function extractArchive(artifact, directory) {
  const code = "import os,posixpath,sys,unicodedata,zipfile; a,d=sys.argv[1:]; z=zipfile.ZipFile(a); infos=z.infolist(); links=[]; expanded=0; seen=set();\ndef name_of(raw):\n n=raw[:-1] if raw.endswith('/') else raw\n if not n or n.startswith('/') or '\\\\' in n or any(not p or p in ('.','..') for p in n.split('/')) or (n!='NeonDiff.app' and not n.startswith('NeonDiff.app/')): raise RuntimeError('archive path rejected')\n return n\ndef add_size(n):\n global expanded\n expanded+=n\n if expanded>536870912: raise RuntimeError('archive byte bound exceeded')\nfor i in infos:\n n=name_of(i.filename); key=unicodedata.normalize('NFKC',n).casefold();\n if key in seen: raise RuntimeError('archive entry collision')\n seen.add(key); mode=(i.external_attr>>16)&0xffff; kind=mode&0o170000\n if kind not in (0,0o040000,0o100000,0o120000): raise RuntimeError('archive special file type unsupported')\n p=os.path.join(d,n)\n if kind==0o120000:\n  if i.file_size>4096: raise RuntimeError('symlink target exceeds bound')\n  with z.open(i) as s: b=s.read(4097)\n  if len(b)>4096: raise RuntimeError('symlink target exceeds bound')\n  try: target=b.decode('utf-8')\n  except UnicodeDecodeError: raise RuntimeError('symlink target is not UTF-8')\n  destination=posixpath.normpath(posixpath.join('NeonDiff.app',posixpath.dirname(n),target))\n  if not target or target.startswith('/') or '\\\\' in target or (destination!='NeonDiff.app' and not destination.startswith('NeonDiff.app/')): raise RuntimeError('symlink target escapes app root')\n  add_size(len(b)); links.append((target,p)); continue\n if i.filename.endswith('/') or kind==0o040000: os.makedirs(p,exist_ok=True); continue\n os.makedirs(os.path.dirname(p),exist_ok=True)\n with z.open(i) as s,open(p,'wb') as t:\n  while True:\n   b=s.read(1048576)\n   if not b: break\n   add_size(len(b)); t.write(b)\n os.chmod(p,(mode&0o111)|(os.stat(p).st_mode&0o666))\nfor target,p in links: os.symlink(target,p)\nz.close()";
  try { execFileSync(PYTHON, ["-I", "-c", code, artifact, directory], { maxBuffer: MAX_METADATA }); } catch { fail("bounded archive extraction failed"); }
}

/** Run the next proof stage while the bounded, exact archive extraction exists. */
export function withExtractedDesktopApp(input, consume) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "artifactPath")) fail("archive inputs have undeclared fields");
  if (typeof consume !== "function") fail("archive consumer is required");
  const artifactPath = text(input.artifactPath, "artifact path"), descriptor = openSync(resolve(artifactPath), constants.O_RDONLY | constants.O_NOFOLLOW); let bytes;
  try { bytes = readBounded(descriptor); } finally { closeSync(descriptor); }
  const artifactSHA256 = createHash("sha256").update(bytes).digest("hex"), temporary = mkdtempSync(join(tmpdir(), "neondiff-tree-proof-"));
  try { const archive = join(temporary, "artifact.zip"); writeFileSync(archive, bytes, { mode: 0o600 }); preflightArchive(archive); extractArchive(archive, temporary); const appPath = join(temporary, "NeonDiff.app"); if (!lstatSync(appPath).isDirectory()) fail("archive does not contain NeonDiff.app"); return consume(Object.freeze({ appPath, artifactSHA256 })); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
