# Text + MathJax prototype (phase 2)

Scaffolding for rendering questions as text instead of images, so no watermark or
sponsor branding can appear. Not linked from the app; open
`prototype/index.html` directly.

## What already exists

The app is already wired for this. `assets/main-rts-phase2-sync-20261006.js`
renders `.inline-question-text > p.question-text` when a test has
`questionDisplay: "text"`, plus an optional diagram image. MathJax 3.2.2 and
`assets/mathjax-renderer.js` are already loaded and typeset `.inline-question-text`,
`.pdf-question .text-version`, `.options` and `.answer-solution-content`.

So the hybrid needs no new rendering code — only better question text.

## Why it is not usable as-is

`prototype/questions.json` holds all 348 embedded questions with their extracted
text. Two problems in the source data:

1. **Line breaks are stored as literal `\n`** (backslash + `n`), not newlines, in
   every one of the 348 records. HTML collapses them, so questions render as one
   run-on blob. `mkproto.py` replaces them and joins the PDF's visual line-wraps
   back into paragraphs.
2. **PDF text extraction lost notation.** Examples from `rts1` Q1 and Q3:
   - `10 3 m/s` should be `10√3 m/s` (the radical is gone)
   - `m/s2` should be `m/s²`
   - `120 / d = / m` is the fraction `d = 120 m` exploded across lines
   - `x2` should be `x²`

   There is no LaTeX to hand to MathJax, so typesetting cannot repair these.

## The split

Classified by evidence of lost notation (`\d \d`, orphan operators/numbers,
`m/s2`-style units):

| class | count | how to render |
|---|---|---|
| prose, no notation lost | ~124 | text + MathJax — no image, no watermark |
| prose but references a figure/table/Column-I | 19 | keep the image |
| math notation lost | 205 | keep the image |

~124 of 348 questions (36%) can drop the image entirely today.

## To finish phase 2

1. Re-extract the text layer per question from the source PDFs with a proper
   layout-preserving extractor (`pdfplumber` / PyMuPDF) that keeps `√`, superscripts
   and inline fractions, and converts display math to LaTeX.
2. Replace the `text` field for the prose-only questions and flip those tests (or
   questions) to `questionDisplay: "text"`.
3. Leave every question that carries a diagram or unrecoverable math on the image
   path — the branding removal in the previous commit already cleaned those.

## Files

- `mkproto.py` (in `$HOME`) — reads the bundle, cleans text, classifies, writes this page.
- `questions.json` — 348 records: `test`, `id`, `subject`, `text`, `image`, `mathy`.
- `index.html` — sample cards showing both modes.
