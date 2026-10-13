#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""相册缩略图总览图（/看全部）

用法：python3 tools/albumgrid.py --manifest /tmp/x.json --out /tmp/g.png
manifest: {"title": "...", "sub": "...",
           "showIds": true,      # 是否画左上角 #编号 徽标（相册封面网格用 false）
           "showAlbum": false,   # 是否在缩略图下方写相册名（相册封面网格用 true）
           "note": "...",        # 底部一行小字；缺省用默认提示，给 null/"" 则不画
           "empty": "还没有图片", # 相册没有图时的占位文字
           "items": [{"id": 1, "path": "...", "album": "相册名"}]}

版式参考 /on查卡 的网格：白底圆角卡 + 缩略图 + 编号；编号就是 /看 <编号> 用的全局编号，
/删除图片 <编号> 删掉后后面的编号前移（编号是位置，不写进文件）。
"""
import argparse
import json
import os
import sys

from PIL import Image, ImageDraw

ON = os.environ.get('ON_DIR') or '/home/admin/bot/data/on'
if ON not in sys.path:
    sys.path.insert(0, ON)
try:
    import cardimg as C
except Exception:                                     # 没装 on 模块也能跑（退化到系统字体）
    C = None

COLS = 6
THUMB = 208
PAD_TOP = 116
MARGIN = 26
GAP = 14
TEXT_H = 14                     # 缩略图下面不再写相册名，只留一点边距
CELL_W = THUMB
CELL_H = THUMB + TEXT_H
FOOTER = 52


def load_fonts():
    if C is not None:
        try:
            return C.pick_fonts()
        except Exception:
            pass
    from PIL import ImageFont
    for p in ('/usr/share/fonts/wqy-microhei/wqy-microhei.ttc',
              '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'):
        if os.path.exists(p):
            return type('F', (), {'get': staticmethod(lambda s, b=True: ImageFont.truetype(p, s))})()
    raise SystemExit('找不到字体')


def cover(path, size):
    """按短边裁成正方形再缩放（cover）"""
    try:
        im = Image.open(path)
    except Exception:
        return None
    im = im.convert('RGB')
    w, h = im.size
    if w <= 0 or h <= 0:
        return None
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    return im.resize((size, size), Image.LANCZOS)


def rounded(im, radius):
    mask = Image.new('L', im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius, fill=255)
    out = im.convert('RGBA')
    out.putalpha(mask)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--cols', type=int, default=COLS)
    a = ap.parse_args()

    with open(a.manifest, encoding='utf-8') as f:
        data = json.load(f)
    items = data.get('items') or []
    show_ids = data.get('showIds', True)
    show_album = data.get('showAlbum', False)
    empty_text = data.get('empty') or '图片缺失'
    note = data.get('note', '/看 <编号> 看单张　/删除图片 <编号> 删除')
    note_lines = [ln for ln in str(note).split('\n')] if note else []
    fonts = load_fonts()
    cols = max(1, min(12, a.cols))
    rows = (len(items) + cols - 1) // cols if items else 1
    text_h = 44 if show_album else 14
    cell_h = THUMB + text_h
    footer = (FOOTER - 24 + 22 * len(note_lines)) if note_lines else 0
    w = MARGIN * 2 + CELL_W * cols + GAP * (cols - 1)
    h = PAD_TOP + rows * cell_h + (rows - 1) * GAP + footer
    im = Image.new('RGB', (w, h), (243, 244, 247))
    dr = ImageDraw.Draw(im)
    dr.rectangle([0, 0, w, 8], fill=(96, 130, 200))

    dr.text((MARGIN, 26), data.get('title') or '相册图片', font=fonts.get(38, True), fill=(28, 32, 42))
    dr.text((MARGIN, 76), data.get('sub') or '', font=fonts.get(17, False), fill=(120, 126, 140))

    if not items:
        dr.text((w / 2, PAD_TOP + 120), '相册里还没有图片', font=fonts.get(28, True),
                fill=(150, 156, 170), anchor='ma')

    for i, it in enumerate(items):
        r, c = divmod(i, cols)
        x = MARGIN + c * (CELL_W + GAP)
        y = PAD_TOP + r * (cell_h + GAP)
        dr.rounded_rectangle([x, y, x + CELL_W, y + cell_h], 14, fill=(255, 255, 255))
        thumb = cover(it.get('path') or '', THUMB - 16)
        if thumb is None:
            dr.rounded_rectangle([x + 8, y + 8, x + CELL_W - 8, y + THUMB - 8], 10, fill=(226, 229, 236))
            dr.text((x + CELL_W / 2, y + THUMB / 2 - 10), empty_text, font=fonts.get(16, False),
                    fill=(150, 156, 168), anchor='ma')
        else:
            im.paste(rounded(thumb, 10), (x + 8, y + 8), rounded(thumb, 10))
        if show_ids:                                  # 编号徽标（左上）
            label = '#%d' % it.get('id', i + 1)
            bw = dr.textlength(label, font=fonts.get(20, True)) + 20
            dr.rounded_rectangle([x + 12, y + 12, x + 12 + bw, y + 42], 12, fill=(28, 32, 42))
            dr.text((x + 12 + bw / 2, y + 17), label, font=fonts.get(20, True),
                    fill=(255, 255, 255), anchor='ma')
        if show_album:                                # 相册名（缩略图下方）
            name = str(it.get('album') or '')
            while name and dr.textlength(name + '…', font=fonts.get(18, True)) > CELL_W - 20:
                name = name[:-1]
            dr.text((x + CELL_W / 2, y + THUMB + 8),
                    (name + '…') if name != str(it.get('album') or '') else name,
                    font=fonts.get(18, True), fill=(52, 58, 70), anchor='ma')

    if note_lines:
        ny = h - footer + 14
        for ln in note_lines:
            dr.text((w / 2, ny), ln, font=fonts.get(15, False), fill=(140, 146, 160), anchor='ma')
            ny += 22
    im.save(a.out, quality=92)
    return a.out, im.size


if __name__ == '__main__':
    p, size = main()
    print('%s  %dx%d' % (p, size[0], size[1]))
