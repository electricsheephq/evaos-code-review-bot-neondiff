#!/usr/bin/env python3
import argparse
import base64
import json
import os
import stat
import sys

MAX_FILES = 20_000
MAX_BYTES = 512 * 1024 * 1024
max_files = MAX_FILES
max_bytes = MAX_BYTES
entry_count = 0
byte_count = 0


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n")


def stable_read(parent_fd, name, relative_path):
    global byte_count
    descriptor = os.open(
        name,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
        dir_fd=parent_fd,
    )
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise RuntimeError("entry is not a regular file")
        if byte_count + before.st_size > max_bytes:
            raise RuntimeError("descriptor traversal bound exceeded")
        data = bytearray()
        remaining = max_bytes - byte_count
        while True:
            chunk = os.read(descriptor, min(1024 * 1024, remaining - len(data) + 1))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > remaining:
                raise RuntimeError("descriptor traversal bound exceeded")
        after = os.fstat(descriptor)
        identity_before = (
            before.st_dev, before.st_ino, before.st_size,
            before.st_mtime_ns, before.st_ctime_ns,
        )
        identity_after = (
            after.st_dev, after.st_ino, after.st_size,
            after.st_mtime_ns, after.st_ctime_ns,
        )
        if identity_before != identity_after or len(data) != after.st_size:
            raise RuntimeError("entry changed during descriptor read")
        byte_count += len(data)
        emit({
            "type": "file",
            "relativePath": relative_path,
            "size": after.st_size,
            "mode": after.st_mode,
            "dataBase64": base64.b64encode(bytes(data)).decode("ascii"),
        })
    finally:
        os.close(descriptor)


def walk(directory_fd, prefix):
    global entry_count
    before = os.fstat(directory_fd)
    for name in sorted(os.listdir(directory_fd), key=os.fsencode):
        entry_count += 1
        if entry_count > max_files:
            raise RuntimeError("descriptor traversal bound exceeded")
        relative_path = f"{prefix}/{name}" if prefix else name
        metadata = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISLNK(metadata.st_mode):
            emit({
                "type": "symlink",
                "relativePath": relative_path,
                "target": os.readlink(name, dir_fd=directory_fd),
            })
        elif stat.S_ISDIR(metadata.st_mode):
            child_fd = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            try:
                emit({"type": "directory", "relativePath": relative_path})
                walk(child_fd, relative_path)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(metadata.st_mode):
            stable_read(directory_fd, name, relative_path)
        else:
            raise RuntimeError("unsupported descriptor tree entry")
    after = os.fstat(directory_fd)
    identity_before = (
        before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns,
    )
    identity_after = (
        after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns,
    )
    if identity_before != identity_after:
        raise RuntimeError("directory changed during descriptor traversal")


def main():
    global max_files, max_bytes
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--root", required=True)
    parser.add_argument("--max-files", type=int, default=MAX_FILES)
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    arguments = parser.parse_args()
    if arguments.max_files < 1 or arguments.max_bytes < 1:
        raise RuntimeError("descriptor traversal bound exceeded")
    max_files = arguments.max_files
    max_bytes = arguments.max_bytes
    root_fd = os.open(
        arguments.root,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        if not stat.S_ISDIR(os.fstat(root_fd).st_mode):
            raise RuntimeError("tree root is not a directory")
        walk(root_fd, "")
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    main()
