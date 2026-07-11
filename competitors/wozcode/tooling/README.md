# WOZCODE deobfuscation tooling

Reproducible pipeline used to produce the findings in [`../analysis.md`](../analysis.md).
This folder ships the **tooling**, not the deobfuscated output itself — see
[Why no output is checked in](#why-no-deobfuscated-output-is-checked-in) below.

## Background

WOZCODE's distributed Claude Code plugin ships its `.js` files (`chunks/`,
`scripts/`, `servers/`, `standalone/` — 59MB across 122 chunk files alone) run
through **`javascript-obfuscator`** on top of an esbuild bundle. This is
confirmed directly: `javascript-obfuscator ^5.4.3` appears in the project's
own `devDependencies`, recovered from a `package.json` bundled verbatim
inside one of their unobfuscated build artifacts (`standalone/savings-check.js`
— see below).

The obfuscation combines:
- **Hex-named variables** (`_0x50af`, `_0x1c0181`, ...) everywhere, including
  function names, so nothing in the output is self-describing.
- **A rotating string array + decoder function.** Every string literal in the
  source is hoisted into one big array and index-shuffled at module-load time;
  call sites reference strings only through a decoder call
  (`_0x3f99(0x1f3)`), never as a literal, so grep-based analysis of the raw
  files is useless — you cannot even search for a known string like
  `"ANTHROPIC_BASE_URL"` in the obfuscated source.
- **A self-defending IIFE** that re-derives the decoder's own source on each
  call and compares it against a reference, intended to break naive
  find/replace deobfuscation attempts.
- **esbuild bundling underneath**, splitting the real source into dozens of
  content-hashed `chunk-XXXXXXXX.js` files cross-imported by minified
  single/double-letter export names (`Tb`, `Vb`, `Yb`, ...) — so even after
  string-array decoding, figuring out which chunk implements what requires
  tracing which entry script imports which named export from which chunk.

## The tool: `webcrack`

[`webcrack`](https://github.com/j4k0xb/webcrack) is a purpose-built
deobfuscator that specifically targets `javascript-obfuscator`'s output
(string-array decoding, dead-code elimination, control-flow un-flattening)
and also un-bundles esbuild/webpack output. Run against one of these files it:

- Fully resolves the string array and rewrites every decoder call back into
  its literal string (`_0x3f99(0x1f3)` → `"ANTHROPIC_BASE_URL"`).
- Eliminates the dead/defensive code paths the obfuscator inserts.
- Restores real control flow (switch-based control-flow flattening gets
  un-flattened back into normal `if`/`for`/etc.).
- Formats the result with real indentation via an internal prettier pass.

**What it does *not* recover**: local variable and function names. Those were
irreversibly replaced at build time — webcrack has no way to know what a
minified identifier used to be called. Every function/variable in the output
stays a meaningless `_0x...` hex name. Reading the output for meaning
requires the same technique you'd use on a stripped binary: infer intent from
recovered string literals (error messages, schema field names, API URLs),
call shape (arity, what gets awaited, what gets thrown), and cross-referencing
which chunk exports get imported by which entry point under what alias.

This is exactly what makes the recovered **string literals** so valuable —
they're the load-bearing evidence behind essentially every claim in
`../analysis.md`: zod schema field names, MCP tool names, regex patterns,
config keys, error messages, and every API endpoint URL cited there was read
directly out of webcrack's output, not guessed.

## Usage

```bash
cd competitors/wozcode/tooling
npm install                 # installs webcrack, prettier, js-beautify (see package.json)

# Single file:
./deobfuscate.sh /path/to/wozcode-plugin/scripts/session-hook.js

# Every top-level *.js in a directory (parallelized):
./deobfuscate.sh /path/to/wozcode-plugin/chunks
```

Output lands at `out/<basename>/deobfuscated.js` (gitignored — see below).
Small entry scripts deobfuscate in about a second; the larger multi-MB
`chunks/*.js` bundles take 10–90 seconds each. `DEOBFUSCATE_JOBS` (default 8)
controls parallelism when pointing at a directory.

You'll need a local clone of `WithWoz/wozcode-plugin` to point the script at —
it isn't vendored into this repository (see below).

### Finding which chunk to deobfuscate next

Because chunk filenames are esbuild content hashes with no semantic meaning,
the practical workflow was: deobfuscate every file in `scripts/` first (small,
fast, and each one's `import` statements — visible immediately after
string-array decoding, since import paths are string literals — name exactly
which `chunks/*.js` files it pulls named exports from), then follow those
import edges outward into `chunks/` only as needed to answer a specific
question (e.g. "what does the `Search` MCP tool's handler actually do"),
rather than attempting to deobfuscate and read all 122 chunk files
up front.

One file, `standalone/savings-check.js`, turned out **not to be obfuscated at
all** — confirmed by webcrack itself reporting `String Array: no` / `0
changes` on the deobfuscate pass — because WOZCODE's own build pipeline has a
`--no-obfuscate` flag (`build:claude` vs. `build:claude:prod`) and this
particular script ships through the unobfuscated path. It retains original
esbuild source comments (e.g. `// src/common/baseline/baseline-scanner.ts`)
and even a verbatim copy of the project's real `package.json` (inlined by
esbuild for version metadata) — this is where the exact dependency list and
build-script names cited in `../analysis.md` came from.

## Why no deobfuscated output is checked in

RTK and Headroom (the other two products analyzed alongside WOZCODE) are
Apache-2.0-licensed open source, so their full source could be cloned and
read directly with no redistribution question. WOZCODE's plugin ships no
open-source license for its `chunks/`/`scripts/`/`servers/` source — it's a
commercial product whose source is deliberately obfuscated specifically to
prevent this kind of reading. Deobfuscating a legitimately-obtained,
publicly-distributed build artifact to understand how it works is standard,
defensible competitive/security research practice; bulk-committing tens of
megabytes of the resulting decompiled proprietary source into this repository
is a separate act with a different (and unnecessary) risk profile, since the
methodology is fully reproducible from the tooling here plus a public
`git clone` of `WithWoz/wozcode-plugin`.

Every specific technical claim in `../analysis.md` is already backed by an
inline quoted string literal, schema shape, or config excerpt captured
directly in that document — so the evidence for each finding is preserved
without needing to also ship the full recovered source tree.
