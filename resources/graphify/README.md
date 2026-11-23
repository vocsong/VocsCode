# Bundled Graphify build inputs

Build Node 22 and the repo's locked npm dependencies are sufficient to stage the runtime. No system Python, pip, compiler, or target-architecture interpreter is used. Ordinary `npm ci` and `npm run build` do not fetch these inputs.

```text
node scripts/graphify-runtime.mjs prepare             # stage the host's development payload
node scripts/graphify-runtime.mjs prepare darwin-x64  # stage Intel payload on a Mac arm64 runner
node scripts/graphify-smoke.mjs                       # smoke the staged dev payload; no downloads
npm run dist:dir -- --publish never                   # build the unpacked app through the standard hooks
node scripts/graphify-smoke.mjs --packaged            # smoke the actual unpacked app in dist/
node --test scripts/graphify-runtime.test.mjs         # offline build/preflight tests
```

`VOCS_GRAPHIFY_BUILD_CACHE` optionally selects a private build cache (`.graphify-build-cache/` in the checkout by default). Only input archives are reused. Each cache hit is rehashed; remove the named entry if it fails verification. Installer staging is fresh, per architecture, and is not read from the developer's tree. Build hooks put that exact stage into the app's resources before signing/archiving. Explicit `--prepackaged` and universal Mac builds are not supported by this build path.

The app invokes the absolute `launch.py` in `process.resourcesPath/graphify-runtime` (dev: `resources/graphify-runtime/<platform>-<arch>`) with the private interpreter and `-I -S -B`. The executable is `python/python.exe` on Windows and `python/bin/python3` on Unix. The launcher accepts `--version` and `extract <absolute project> --code-only --exclude .vocs-code --out <absolute output>`. It bypasses Graphify's public CLI startup, including editor-skill refresh and non-isolated re-exec. No package discovery or dependency resolution occurs at runtime. Extraction uses Graphify's file-based ignore rules; it does not invoke optional external Git queries (e.g. to look up the user's custom `core.excludesFile`).

## Updating the lock

- `artifacts.lock.json` pins the exact URLs, byte counts and SHA-256s. Obtain the CPython digests from the official [Python Build Standalone release metadata](https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20261110); use only `install_only_stripped` for these triples. Obtain wheel hashes from the official PyPI version JSON / Simple API, not from a configured package mirror. Verify all four complete binary-wheel sets, including the full `graphifyy` dependency closure with `extra == ''` on CPython 3.12. The 31 locked distributions have no enabled extras and need no wheel install hooks.
- The wheel set uses `cp312`/compatible `abi3` or platform-independent `py3-none-any`. It covers Windows x64, glibc Linux x64 (wheel tags at or below glibc 2.17), and separate macOS Intel/Apple Silicon builds compatible with macOS 12 wheel tags. It does not add support for other Electron targets or musl. NumPy 2.2.6 and RapidFuzz 3.13.0 provide binaries within those Linux/macOS tag bounds; do not upgrade to higher deployment targets silently.
- Preserve upstream `LICENSE`/`NOTICE` data and review native libraries' redistribution terms. `THIRD_PARTY_NOTICES.md` and `licenses/` ship with the interpreter and wheel metadata. The wheel `tree-sitter-groovy==0.1.2` needs its accompanying attribution/terms file because upstream only declares MIT in metadata. On a Graphify version bump, re-review the exact dispatch path and allowed flags in `launch.py` and re-run the extraction smoke, not just the version probe.
- Cross-staging performs format/arch checks without running a foreign binary. The path-filtered Graphify bundle workflow runs the packaged worker natively on Linux and both Mac architectures before release. Before publishing installers, verify the source availability and any required corresponding-source notices for the exact native libraries shipped in NumPy's wheels, including libquadmath.
