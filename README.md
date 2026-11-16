# marked-faster

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Darkarmy921/marked-faster/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Darkarmy921/marked-faster/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A drop-in replacement for `marked` 18.1.3, written from scratch with no
dependencies. It renders Markdown to exactly the same HTML `marked`
produces with its default options — the same strings, byte for byte — and
does it faster.

## What is in here

- `parse.js` — the whole renderer. One exported function,
  `parse(markdown)`, which returns the HTML string. It is a plain ES
  module with no imports, no vendored code, and no state carried from one
  call to the next.
- `main.ts` — the driver the harness runs. It reads the cases from
  `cases.json` in the input directory, renders each case on its own with
  `parse`, and writes the resulting HTML strings, in order, to
  `html.json` in the output directory.

## How the renderer works

Parsing happens in two passes. The first pass walks the lines and builds
the block structure — headings, paragraphs, code fences, blockquotes,
lists, tables, HTML blocks — while collecting link reference definitions
as it goes. Inline parsing runs only after that, so a link reference
defined later in the document still resolves, exactly as `marked` does.

Inline content is scanned into a list of nodes, and emphasis plus
strikethrough are settled with a delimiter stack that follows the
flanking rules and the rule of three. The details that make the output
match `marked` rather than just resemble it are all handled deliberately:
numeric-only character-reference decoding, backpedal trimming of
extended autolinks, `~foo~` strikethrough, and the way list items indent
their contents. Blockquotes and list items are parsed by recursing over
their stripped line ranges.

## Measured results

Correctness was checked against the kit's practice set: **720 out of 720
cases produce HTML identical to `marked` 18.1.3**, and the local grader
confirms the same 720/720.

Speed was measured cold (fresh process, no warm-up) on 40 generated
README documents, 8 rounds each: this renderer took a median of
**888.6 ms** against **1010.1 ms** for `marked` 18.1.3 — about **12%
faster**. Over the full 720-case set the gap is around **10%**.

## License

MIT — see `LICENSE`.
