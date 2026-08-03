# Third-party components and why the licence is GPL-3.0-or-later

SpiceLab is licensed **GPL-3.0-or-later**. That is not a preference — it is the
weakest licence that accommodates everything the project builds against.

This file records what those components are, so the reasoning can be checked
rather than taken on trust.

> Not legal advice. This is a reasoned engineering choice; if the project is
> ever distributed commercially, have it reviewed.

---

## What is in this repository

| Component | Origin | Licence |
|---|---|---|
| Rust solver, JS worker/editor/instruments, tests | written here | GPL-3.0-or-later |
| `src/schematic/parts.js` — model card parameters | ngspice test and example netlists | Modified BSD |
| `scripts/ngshim.c` | written here; compiles against ngspice headers | GPL-3.0-or-later |

`parts.js` carries per-part provenance: the originating file, the upstream
repository, the commit hash and the retrieval date. ngspice's `COPYING` places
"all of its source code, test and example files" under the Modified BSD licence,
and its listed exceptions are all source directories — not the test and example
netlists these cards come from.

## What the build links against, but this repository does NOT contain

`scripts/build-ngspice.sh` downloads and compiles ngspice 46. The result lands
in `src/ngspice/`, which is `.gitignore`d. **The binary it produces is a
combined work**, and that is what drives the licence choice:

| Part of ngspice | Licence | Used? |
|---|---|---|
| Core simulator | Modified BSD | yes |
| `src/maths/KLU` | LGPLv2.1 | **yes** — enabled deliberately; it is the fast sparse solver |
| `src/frontend/numparam` | LGPLv2.1+ | yes — `.param` evaluation |
| `src/maths/sparse` | MIT-compatible | fallback solver |
| `src/osdi` (Verilog-A) | MPL 2.0 | no — disabled |
| `src/xspice` | public domain, except `icm/table` (GPLv2+) | no — disabled |
| `src/tclspice.c` | LGPLv2.1 | no |

## The reasoning

- **Modified BSD → GPL is fine.** BSD-licensed code may be incorporated into a
  GPL work; the notices must be preserved, which is what `parts.js` does.
- **LGPL-2.1 is the binding constraint.** KLU and numparam are LGPL-2.1, and
  they are linked statically into a single WebAssembly module. Section 3 of
  LGPL-2.1 permits applying the ordinary GPL "version 2 or, at your option, any
  later version" to a copy, which makes GPL-3.0 available.
- **Static linking into wasm is why this matters.** LGPL's usual accommodation
  is dynamic linking, so the user can substitute their own build of the library.
  A wasm module is one artifact with no dynamic linking, so the LGPL relinking
  obligation would otherwise have to be satisfied some other way. Choosing GPL
  for the whole work removes the question.
- **A permissive licence was available but not honest.** With
  `--disable-klu` and `.param` pre-resolution the build would be BSD/MIT only.
  That was considered and rejected: KLU is the reason large circuits are fast,
  and disabling it to win a licence badge would be trading a real capability for
  a cosmetic one.

## Not bundled, deliberately

Vendor model libraries (`.lib`, `.sub`) are **not** included and must not be
added. A manufacturer publishes a model so you can simulate their part;
downloading and using one is the intended use, redistributing it inside another
product generally is not, and a third-party repository that aggregates them
grants nothing its author never held.

`src/schematic/libraries.js` lists where to get them, with each entry's licence
and a flag recording whether that licence was actually read from the source.
**Import model file…** in the editor loads one from local disk into the
document; it is never uploaded.
