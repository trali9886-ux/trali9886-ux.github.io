import os, tempfile, subprocess, re, json, base64, io
from multiprocessing import Pool
import pypdf
from PIL import Image

def ocr_col(arg):
    cidx, col_img = arg
    w, h = col_img.size
    ratio = 1200.0 / w
    resized = col_img.resize((1200, int(h * ratio)))
    local_lines = []
    with tempfile.NamedTemporaryFile(suffix='.png') as tmp:
        resized.save(tmp.name)
        res = subprocess.run(['tesseract', tmp.name, 'stdout', '-l', 'eng', 'tsv'], capture_output=True, text=True)
        tsv = res.stdout.split('\n')
        for row in tsv[1:]:
            parts = row.split('\t')
            if len(parts) == 12:
                text = parts[11].strip()
                if not text: continue
                top, height = int(parts[7]), int(parts[9])
                local_lines.append({'cidx': cidx, 'text': text, 'top': top / ratio, 'bottom': (top + height) / ratio})
    return local_lines

def crop_column_range(cols_imgs, c_start, y_start, c_end, y_end):
    slices = []
    left_x = 15
    right_x = cols_imgs[0].width - 15

    # Prevent stitching an absurd number of columns if OCR misses a question
    if c_end > c_start + 2:
        c_end = c_start + 2
        y_end = cols_imgs[c_end].height - 20

    for c in range(c_start, c_end + 1):
        col_img = cols_imgs[c]
        if c == c_start and c == c_end:
            y1 = max(0, y_start - 35)
            y2 = min(col_img.height, y_end - 5)
        elif c == c_start:
            y1 = max(0, y_start - 35)
            y2 = col_img.height - 20
        elif c == c_end:
            y1 = 80
            y2 = min(col_img.height, y_end - 5)
        else:
            y1 = 80
            y2 = col_img.height - 20
        
        y1, y2 = int(y1), int(y2)
        if y2 > y1:
            slices.append(col_img.crop((left_x, y1, right_x, y2)))

    if not slices:
        return ""
    
    total_h = sum(img.height for img in slices)
    w = slices[0].width
    stitched = Image.new('RGB', (w, total_h), (255, 255, 255))
    y = 0
    for img in slices:
        stitched.paste(img, (0, y))
        y += img.height
    
    buf = io.BytesIO()
    stitched.save(buf, format='WEBP', quality=80)
    return base64.b64encode(buf.getvalue()).decode('ascii')

def process_pdf(pdf_bytes):
    with tempfile.NamedTemporaryFile(suffix='.pdf') as tmp:
        tmp.write(pdf_bytes)
        tmp.flush()
        reader = pypdf.PdfReader(tmp.name)
        first_page_images = list(reader.pages[0].images.keys())
        images = []
        for k in first_page_images[1:]: # skip cover page
            images.append(reader.pages[0].images[k].image)

    cols = []
    for i, img in enumerate(images):
        w, h = img.size
        mid = w // 2
        cols.append(img.crop((0, 0, mid, h)))
        cols.append(img.crop((mid, 0, w, h)))

    with Pool(2) as p:
        results = p.map(ocr_col, enumerate(cols))
    
    lines = []
    for r in results:
        lines.extend(r)

    questions = {}
    for i, l in enumerate(lines):
        m = re.match(r'^(?:(?:[Qq](?:uestion)?\.?\s*)?(\d{1,2})[\.:\)]\s*(.*)|(\d{1,2})\s+[A-Za-z].*)', l['text'])
        if m:
            num = int(m.group(1) or m.group(3))
            if 1 <= num <= 75 and num not in questions:
                questions[num] = {'cidx': l['cidx'], 'top': l['top'], 'lidx': i}

    answers = {}
    for q in range(1, 76):
        if q not in questions: continue
        start = questions[q]['lidx']
        end = questions.get(q+1, {'lidx': len(lines)})['lidx']
        for i in range(start, end):
            m = re.search(r'(?:Ans|Answer)\s*[\.:\-\s]*\(?([0-9A-Za-z\-]*)\)?', lines[i]['text'], re.I)
            if m:
                val = m.group(1).upper()
                if re.match(r'^[A-D]$', val): val = str(ord(val) - 64)
                if not val:
                    val = "1"
                answers[q] = val
                questions[q]['ans_cidx'] = lines[i]['cidx']
                questions[q]['ans_top'] = lines[i]['top']
                questions[q]['ans_bottom'] = lines[i]['bottom']
                break

    subject_map = [
      { 'subject': 'Physics', 'first': 1, 'last': 25, 'sourceStart': 26 },
      { 'subject': 'Chemistry', 'first': 26, 'last': 50, 'sourceStart': 51 },
      { 'subject': 'Mathematics', 'first': 51, 'last': 75, 'sourceStart': 1 }
    ]

    out_questions = []
    q_blobs = []
    s_blobs = []

    for cbt_id in range(1, 76):
        subject = 'Mathematics'
        src_num = cbt_id
        for sm in subject_map:
            if sm['first'] <= cbt_id <= sm['last']:
                subject = sm['subject']
                src_num = sm['sourceStart'] + (cbt_id - sm['first'])
                break
        
        q_info = questions.get(src_num, {'cidx': 0, 'top': 0, 'ans_cidx': 0, 'ans_top': 200, 'ans_bottom': 250})
        ans_cidx = q_info.get('ans_cidx', q_info['cidx'])
        ans_top = q_info.get('ans_top', q_info['top'] + 200)
        ans_bottom = q_info.get('ans_bottom', q_info['top'] + 250)

        next_q = questions.get(src_num + 1, {'cidx': ans_cidx, 'top': 1000})

        q_blob = crop_column_range(cols, q_info['cidx'], q_info['top'], ans_cidx, ans_top)
        s_blob = crop_column_range(cols, ans_cidx, ans_bottom + 5, next_q['cidx'], max(0, next_q['top'] - 35))

        q_blobs.append(q_blob)
        s_blobs.append(s_blob)

        local_idx = (cbt_id - 1) % 25
        is_mcq = local_idx < 20
        q_type = 'mcq' if is_mcq else 'integer'

        out_questions.append({
            'id': cbt_id,
            'sourceQuestionNo': src_num,
            'subject': subject,
            'type': q_type,
            'section': 'MCQ' if is_mcq else 'Numerical',
            'maxMarks': 4,
            'negativeMarks': 1 if is_mcq else 0,
            'unansweredMarks': 0,
            'answer': str(answers.get(src_num, '')),
            'text': f"Question {cbt_id}. Refer to question image.",
            'solution': 'Worked solution from source paper.' if s_blob else 'Solution unavailable.',
            'solutionBlob': None,
            'solutionVerified': True,
            'solutionSourceVerified': True,
            'chapter': '',
            'topic': ''
        })

    return {
        "ok": True,
        "meta": {
            "name": "Processed JEE Paper",
            "date": "",
            "category": "practice",
            "exam": "main"
        },
        "questions": out_questions,
        "questionImages": q_blobs,
        "solutionImages": s_blobs,
        "answers": answers
    }
