"""Private, code-only entry point for the pinned Graphify wheel (not its public CLI)."""

import sys

if not (sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode):
    raise SystemExit("Bundled Graphify requires Python -I -S -B")

import argparse
import os
from importlib.metadata import version
from pathlib import Path

GRAPHIFY_VERSION = "0.9.115"
ROOT = Path(__file__).resolve().parent
PYTHON = ROOT / "python"
VENDOR = ROOT / "vendor"


def stop_external_calls(event, _args):
    # Graphify's optional `git` lookups fall back to its file-based ignore rules
    # on OSError. Do not resolve an executable from PATH (or the repo on Windows).
    # Python's multiprocessing workers use the private interpreter directly.
    if event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn"}:
        raise FileNotFoundError("External commands are disabled in bundled Graphify")
    if event in {"socket.connect", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.sendto"}:
        raise OSError("Network calls are disabled in bundled Graphify")


def main():
    if (
        not Path(sys.executable).resolve().is_relative_to(PYTHON)
        or Path(sys.base_prefix).resolve() != PYTHON
        or not all(entry and Path(entry).resolve().is_relative_to(PYTHON) for entry in sys.path)
        or not VENDOR.is_dir() or VENDOR.resolve() != VENDOR
    ):
        raise SystemExit("Bundled Graphify requires its private Python and vendor directory")
    sys.path.append(str(VENDOR))
    sys.addaudithook(stop_external_calls)

    argv = sys.argv[1:]
    if argv != ["--version"]:
        usage = "extract <absolute project> --code-only [--exclude PATTERN] --out <absolute output>"
        parser = argparse.ArgumentParser(prog="Bundled Graphify", usage=f"%(prog)s --version | {usage}",
                                         add_help=False, allow_abbrev=False)
        if not argv or argv[0] != "extract":
            parser.error("only --version and code-only extract are supported")
        parser.add_argument("project", type=Path)
        parser.add_argument("--code-only", action="store_true", required=True)
        parser.add_argument("--exclude", action="append", default=[])
        parser.add_argument("--out", required=True, type=Path)
        args = parser.parse_args(argv[1:])
        if not args.project.is_absolute() or not args.out.is_absolute():
            parser.error("project and output paths must be absolute")

    installed = version("graphifyy")
    if installed != GRAPHIFY_VERSION:
        raise SystemExit(f"Expected graphifyy=={GRAPHIFY_VERSION}, found {installed}")
    if argv == ["--version"]:
        print(f"graphify {installed}")
        return

    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    # Graphify's nearest-VCS-root discovery stops at Path.home(). Give it the
    # snapshot as its home so enclosing Git checkouts and real profile ignore
    # rules cannot influence the index (including when userData is nested in a repo).
    home = str(args.project.resolve())
    os.environ.update(HOME=home, USERPROFILE=home, XDG_CONFIG_HOME=home, APPDATA=home, LOCALAPPDATA=home)
    os.environ["GRAPHIFY_BACKEND"] = "none"
    # Automatic desktop work stays on one core and needs no worker children.
    os.environ["GRAPHIFY_MAX_WORKERS"] = "1"
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["OMP_NUM_THREADS"] = "1"
    # The public main() re-execs with non-isolated Python and refreshes stale
    # editor skills before dispatch. Invoke only the pinned extract handler.
    from graphify.cli import dispatch_command
    dispatch_command("extract")


if __name__ == "__main__":
    main()
