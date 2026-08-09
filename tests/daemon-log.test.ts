import {
  closeSync,
  chmodSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLaunchdLogWriter,
  formatDaemonLog,
  installLaunchdDaemonConsole
} from "../src/daemon-log.js";

describe("daemon heartbeat logs", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("emits structured JSON with cycle and result counters", () => {
    const log = JSON.parse(formatDaemonLog({
      event: "daemon_cycle_complete",
      cycle: 2,
      dryRun: true,
      result: {
        reposScanned: 2,
        pullsSeen: 4,
        reviewed: 0,
        skippedDraft: 1,
        skippedCanary: 2,
        skippedProcessed: 1
      }
    }, new Date("2026-07-01T00:00:00.000Z")));

    expect(log).toMatchObject({
      ts: "2026-07-01T00:00:00.000Z",
      level: "info",
      event: "daemon_cycle_complete",
      cycle: 2,
      dryRun: true,
      result: {
        reposScanned: 2,
        reviewed: 0,
        skippedProcessed: 1
      }
    });
  });

  it("redacts secret-looking strings before they reach launchd logs", () => {
    const log = formatDaemonLog({
      event: "daemon_cycle_failed",
      level: "error",
      error: "request failed with ghp_fake_token"
    }, new Date("2026-07-01T00:00:00.000Z"));

    expect(log).toContain("[redacted-secret]");
    expect(log).not.toContain("ghp_fake_token");
  });

  it("routes owned daemon console output through bounded redacted streams", () => {
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      installLaunchdDaemonConsole({
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line)
      });
      console.log("cycle", { ok: true });
      console.warn("failed with ghp_fake_token");
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }
    expect(stdout).toEqual(["cycle { ok: true }"]);
    expect(stderr).toEqual(["failed with [redacted-secret]"]);
  });

  it("rotates launchd output by copying then truncating the inherited inode", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "neondiff-launchd-log-")));
    roots.push(root);
    const livePath = join(root, "launchd.out.log");
    const fd = openSync(livePath, "a", 0o600);
    try {
      writeSync(fd, "12345678");
      const before = fstatSync(fd);
      const writer = createLaunchdLogWriter({
        path: livePath,
        fd,
        maxBytes: 10,
        archiveCount: 2,
        maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
        now: () => new Date("2026-08-10T00:00:00.000Z")
      });

      writer("new");

      const afterFd = fstatSync(fd);
      const afterPath = statSync(livePath);
      expect({ dev: afterFd.dev, ino: afterFd.ino }).toEqual({ dev: before.dev, ino: before.ino });
      expect({ dev: afterPath.dev, ino: afterPath.ino }).toEqual({ dev: before.dev, ino: before.ino });
      expect(readFileSync(livePath, "utf8")).toBe("new\n");
      const archives = readdirSync(root).filter((name) => name !== basename(livePath));
      expect(archives).toHaveLength(1);
      expect(readFileSync(join(root, archives[0]!), "utf8")).toBe("12345678");
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(livePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, archives[0]!)).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(fd);
    }
  });

  it("bounds archive count and age without touching unrelated files", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "neondiff-launchd-retention-")));
    roots.push(root);
    const livePath = join(root, "launchd.out.log");
    const unrelatedPath = join(root, "operator-notes.log");
    const fd = openSync(livePath, "a", 0o600);
    const times = [
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T01:00:00.000Z",
      "2026-08-10T02:00:00.000Z"
    ];
    let index = 0;
    try {
      writeSync(fd, "12345678");
      writeFileSync(unrelatedPath, "keep", { mode: 0o600 });
      const writer = createLaunchdLogWriter({
        path: livePath,
        fd,
        maxBytes: 10,
        archiveCount: 2,
        maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
        now: () => new Date(times[Math.min(index++, times.length - 1)]!)
      });
      writer("a");
      writer("12345678");
      writer("b");
      writer("12345678");
      writer("c");
      const archives = readdirSync(root).filter((name) => name.includes(".neondiff-") && name.endsWith(".archive"));
      expect(archives).toHaveLength(2);
      expect(readFileSync(unrelatedPath, "utf8")).toBe("keep");

      const oldestArchive = join(root, archives[0]!);
      utimesSync(oldestArchive, new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z"));
      createLaunchdLogWriter({
        path: livePath,
        fd,
        maxBytes: 10,
        archiveCount: 2,
        maxAgeMs: 24 * 60 * 60 * 1_000,
        now: () => new Date("2026-08-10T03:00:00.000Z")
      });
      expect(readdirSync(root)).not.toContain(basename(oldestArchive));
      expect(readFileSync(unrelatedPath, "utf8")).toBe("keep");
    } finally {
      closeSync(fd);
    }
  });

  it("fails closed before truncation for permissive, symlinked, or mismatched logs", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "neondiff-launchd-log-guard-")));
    roots.push(root);
    const livePath = join(root, "launchd.out.log");
    const otherPath = join(root, "other.log");
    const symlinkPath = join(root, "symlink.log");
    const fd = openSync(livePath, "a", 0o600);
    const otherFd = openSync(otherPath, "a", 0o600);
    try {
      writeSync(fd, "preserve");
      chmodSync(livePath, 0o644);
      expect(() => createLaunchdLogWriter({ path: livePath, fd, maxBytes: 1 })).toThrow(
        "must not be group or world accessible"
      );
      expect(readFileSync(livePath, "utf8")).toBe("preserve");
      chmodSync(livePath, 0o600);

      symlinkSync(livePath, symlinkPath);
      expect(() => createLaunchdLogWriter({ path: symlinkPath, fd, maxBytes: 1 })).toThrow(
        "regular non-symlink file"
      );
      expect(readFileSync(livePath, "utf8")).toBe("preserve");

      expect(() => createLaunchdLogWriter({ path: livePath, fd: otherFd, maxBytes: 1 })).toThrow(
        "same regular file"
      );
      expect(readFileSync(livePath, "utf8")).toBe("preserve");

      const collision = join(
        root,
        `${basename(livePath)}.neondiff-20260810T000000000Z-${process.pid}-1.archive.tmp`
      );
      writeFileSync(collision, "private collision", { mode: 0o600 });
      const writer = createLaunchdLogWriter({
        path: livePath,
        fd,
        maxBytes: 1,
        now: () => new Date("2026-08-10T00:00:00.000Z")
      });
      expect(() => writer("x")).toThrow();
      expect(readFileSync(livePath, "utf8")).toBe("preserve");
    } finally {
      closeSync(otherFd);
      closeSync(fd);
    }
  });
});
