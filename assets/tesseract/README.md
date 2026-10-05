# Browser OCR runtime

The editor vendors Tesseract.js 5.1.1 and tesseract.js-core 5.1.1 for same-origin, on-device OCR. It uses the English `tessdata_fast` model. The model is downloaded from this repo as a static asset and is cached by the browser; PDF pages are not uploaded to a remote OCR API.

The OCR engine only recognizes text and coordinates. Question boundary detection uses ordered page coordinates, section headings and sequential question-number runs. OCR does not generate or guess answers, explanations, or missing questions.

Licenses are in `LICENSE-tesseract.js`, `LICENSE-worker.txt`, `LICENSE-tesseract-core`, and `LICENSE-tessdata-fast`.
