#!/usr/bin/env python3
import sys
import os
import json
import argparse
from PIL import Image, ImageDraw, ImageFont

# Canvas dimensions (3:4 ratio optimal for WhatsApp mobile viewing)
W, H = 960, 1280

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

def get_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

ELEMENT_COLORS = {
    "Fire": (249, 115, 22),
    "Water": (6, 182, 212),
    "Wind": (45, 212, 191),
    "Earth": (217, 119, 6),
    "Nature": (16, 185, 129),
    "Electro": (234, 179, 8),
    "Ice": (56, 189, 248),
    "Dark": (168, 85, 247),
    "Light": (253, 224, 71),
    "Sound": (99, 102, 241),
    "Blood": (220, 38, 38),
    "Bone": (226, 232, 240),
    "Sand": (245, 158, 11),
    "Mist": (148, 163, 184),
    "Fruits": (236, 72, 153),
    "Paper": (241, 245, 249),
    "Magma": (234, 88, 12),
    "Gel": (20, 184, 166),
}

def draw_hud_corners(draw, box, length=16, color=(0, 229, 255), width=2):
    x1, y1, x2, y2 = box
    draw.line([(x1, y1), (x1 + length, y1)], fill=color, width=width)
    draw.line([(x1, y1), (x1, y1 + length)], fill=color, width=width)
    draw.line([(x2, y1), (x2 - length, y1)], fill=color, width=width)
    draw.line([(x2, y1), (x2, y1 + length)], fill=color, width=width)
    draw.line([(x1, y2), (x1 + length, y2)], fill=color, width=width)
    draw.line([(x1, y2), (x1, y2 - length)], fill=color, width=width)
    draw.line([(x2, y2), (x2 - length, y2)], fill=color, width=width)
    draw.line([(x2, y2), (x2, y2 - length)], fill=color, width=width)

def draw_header(draw, title_type="CITIZEN DOSSIER"):
    f_sys = get_font(FONT_MONO, 14)
    f_type = get_font(FONT_BOLD, 16)
    draw.text((60, 46), "◈ ALLYSSEA WORLD SYSTEM ◈", font=f_sys, fill=(0, 229, 255, 200))
    draw.text((W - 60, 46), title_type, font=f_type, fill=(148, 163, 184), anchor="ra")
    draw.line([(60, 78), (W - 60, 78)], fill=(0, 229, 255, 90), width=1)

def draw_footer(draw, subtext="ALLYSSEA WORLD SYSTEM · REAL-TIME REGISTRY"):
    f_foot = get_font(FONT_MONO, 13)
    draw.line([(60, H - 65), (W - 60, H - 65)], fill=(30, 41, 59), width=1)
    draw.text((60, H - 48), subtext, font=f_foot, fill=(148, 163, 184))
    draw.text((W - 60, H - 48), "STATUS: VERIFIED", font=f_foot, fill=(0, 229, 255, 220), anchor="ra")

def draw_segmented_bar(draw, x, y, w, h, current, max_val, color_fill, color_bg, segments=10):
    draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=color_bg)
    pct = max(0.0, min(1.0, current / max(1, max_val)))
    fill_w = int(w * pct)
    if fill_w > 0:
        draw.rounded_rectangle([x, y, x + fill_w, y + h], radius=h // 2, fill=color_fill)
        draw.line([(x + 4, y + 2), (x + fill_w - 4, y + 2)], fill=(255, 255, 255, 120), width=1)
    seg_step = w / segments
    for s in range(1, segments):
        sx = int(x + s * seg_step)
        draw.line([(sx, y), (sx, y + h)], fill=(15, 23, 42, 180), width=1)

def render_character_card(data, out_path):
    img = Image.new("RGBA", (W, H), (7, 10, 18, 255))
    draw = ImageDraw.Draw(img)

    # Outer HUD Frame
    draw.rectangle([40, 28, W - 40, H - 28], outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (40, 28, W - 40, H - 28), length=24, color=(0, 229, 255), width=3)

    # Header
    draw_header(draw, "STATUS WINDOW : CITIZEN DOSSIER")

    # Name and Title Section
    name = (data.get("name") or "Unknown").upper()
    titles = data.get("titles") or []
    title_str = f"« {titles[0]} »" if titles else "« Warga Resmi Allyssea »"

    f_name = get_font(FONT_BOLD, 46)
    f_title = get_font(FONT_REGULAR, 18)

    draw.text((60, 102), name, font=f_name, fill=(248, 250, 252))
    draw.text((60, 162), title_str, font=f_title, fill=(56, 189, 248))

    # Badges Row (Rank, Level, Element, Will of Path)
    rank = str(data.get("rank") or "E").upper()
    level = str(data.get("level") or "1")
    element = str(data.get("element") or "Neutral")
    will = str(data.get("willOfPath") or "Neutral")

    elem_color = ELEMENT_COLORS.get(element, (0, 229, 255))

    badges = [
        ("RANK", rank, (234, 179, 8)),
        ("LEVEL", level, (0, 229, 255)),
        ("ELEMENT", element, elem_color),
        ("PATH", will, (168, 85, 247)),
    ]

    bx = 60
    by = 205
    bw = 192
    bh = 54
    f_badge_lbl = get_font(FONT_MONO, 11)
    f_badge_val = get_font(FONT_BOLD, 17)

    for lbl, val, col in badges:
        draw.rounded_rectangle([bx, by, bx + bw, by + bh], radius=6, fill=(13, 19, 33), outline=col, width=1)
        draw.text((bx + 14, by + 10), lbl, font=f_badge_lbl, fill=(148, 163, 184))
        draw.text((bx + 14, by + 28), val, font=f_badge_val, fill=col)
        bx += bw + 20

    # Main Identity Dossier Panel
    px1, py1, px2, py2 = 60, 280, W - 60, 685
    draw.rounded_rectangle([px1, py1, px2, py2], radius=10, fill=(11, 16, 28), outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (px1, py1, px2, py2), length=16, color=(56, 189, 248), width=2)

    f_sec = get_font(FONT_BOLD, 16)
    draw.text((px1 + 24, py1 + 18), "IDENTITAS PRIBADI & KLASIFIKASI", font=f_sec, fill=(0, 229, 255))
    draw.line([(px1 + 24, py1 + 44), (px2 - 24, py1 + 44)], fill=(30, 41, 59), width=1)

    fields = [
        ("RAS", data.get("race") or "—"),
        ("KELAS", data.get("className") or "—"),
        ("USIA / GENDER", f"{data.get('age', '—')} Thn · {data.get('gender', '—')}"),
        ("TANGGAL LAHIR", data.get("birthday") or "—"),
        ("ASAL BENUA", data.get("origin") or "—"),
        ("AFILIASI / CREW", data.get("crew") or "—"),
        ("PROFESI", data.get("profession") or "—"),
        ("SPIRIT PELINDUNG", data.get("spirit") or "—"),
    ]

    f_flbl = get_font(FONT_MONO, 12)
    f_fval = get_font(FONT_BOLD, 18)

    row_y = py1 + 60
    for i in range(0, len(fields), 2):
        lbl1, val1 = fields[i]
        draw.text((px1 + 28, row_y), lbl1, font=f_flbl, fill=(148, 163, 184))
        draw.text((px1 + 28, row_y + 18), str(val1), font=f_fval, fill=(241, 245, 249))

        if i + 1 < len(fields):
            lbl2, val2 = fields[i + 1]
            draw.text((px1 + 420, row_y), lbl2, font=f_flbl, fill=(148, 163, 184))
            draw.text((px1 + 420, row_y + 18), str(val2), font=f_fval, fill=(241, 245, 249))

        row_y += 72
        if i < len(fields) - 2:
            draw.line([(px1 + 24, row_y - 10), (px2 - 24, row_y - 10)], fill=(20, 28, 45), width=1)

    # Vitality Snapshot Panel (HP / SE Bars)
    stats = data.get("stats") or {}
    hp = stats.get("hp", 800)
    max_hp = stats.get("maxHp", 800)
    se = stats.get("se", 200)
    max_se = stats.get("maxSe", 200)

    vx1, vy1, vx2, vy2 = 60, 705, W - 60, 890
    draw.rounded_rectangle([vx1, vy1, vx2, vy2], radius=10, fill=(11, 16, 28), outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (vx1, vy1, vx2, vy2), length=16, color=(0, 229, 255), width=2)

    draw.text((vx1 + 24, vy1 + 18), "VITALITAS BINTANG (STATUS RINGKAS)", font=f_sec, fill=(0, 229, 255))

    bar_w = 640
    f_bar_lbl = get_font(FONT_MONO, 13)
    f_bar_num = get_font(FONT_BOLD, 15)

    # HP Bar
    draw.text((vx1 + 24, vy1 + 50), "HP", font=f_bar_lbl, fill=(255, 75, 120))
    draw.text((vx2 - 24, vy1 + 50), f"{hp} / {max_hp}", font=f_bar_num, fill=(241, 245, 249), anchor="ra")
    draw_segmented_bar(draw, vx1 + 65, vy1 + 52, bar_w, 18, hp, max_hp, (255, 42, 95), (40, 16, 28))

    # SE Bar
    draw.text((vx1 + 24, vy1 + 86), "SE", font=f_bar_lbl, fill=(0, 220, 255))
    draw.text((vx2 - 24, vy1 + 86), f"{se} / {max_se}", font=f_bar_num, fill=(241, 245, 249), anchor="ra")
    draw_segmented_bar(draw, vx1 + 65, vy1 + 88, bar_w, 18, se, max_se, (0, 210, 255), (14, 30, 50))

    # Quick Attribute row preview as 7 visual mini-chips
    f_chip_lbl = get_font(FONT_MONO, 11)
    f_chip_val = get_font(FONT_BOLD, 13)
    stat_keys = [
        ("STR", stats.get("str", 10)),
        ("DEF", stats.get("def", 10)),
        ("MP",  stats.get("mp", 10)),
        ("RES", stats.get("res", 10)),
        ("SPD", stats.get("spd", 10)),
        ("INT", stats.get("int", 10)),
        ("LCK", stats.get("lck", 10)),
    ]
    cx = vx1 + 24
    cw = 104
    ch = 38
    for scode, sval in stat_keys:
        draw.rounded_rectangle([cx, vy1 + 124, cx + cw, vy1 + 124 + ch], radius=4, fill=(15, 23, 42), outline=(30, 41, 59), width=1)
        draw.text((cx + 8, vy1 + 135), scode, font=f_chip_lbl, fill=(0, 229, 255))
        draw.text((cx + cw - 8, vy1 + 135), str(sval), font=f_chip_val, fill=(241, 245, 249), anchor="ra")
        cx += cw + 14

    # Motto Panel
    motto = data.get("motto") or "Melangkah dalam bayang, mencari jalan terang di Allyssea."
    
    mx1, my1, mx2, my2 = 60, 910, W - 60, 1050
    draw.rounded_rectangle([mx1, my1, mx2, my2], radius=10, fill=(11, 16, 28), outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (mx1, my1, mx2, my2), length=16, color=(56, 189, 248), width=2)
    
    draw.text((mx1 + 24, my1 + 18), "MOTTO HIDUP & TEKAD WARGA", font=f_sec, fill=(0, 229, 255))
    f_motto = get_font(FONT_REGULAR, 15)
    
    words = motto.split()
    lines = []
    cur_line = []
    for w in words:
        cur_line.append(w)
        if len(" ".join(cur_line)) > 65:
            lines.append(" ".join(cur_line))
            cur_line = []
    if cur_line:
        lines.append(" ".join(cur_line))
    
    m_y = my1 + 50
    for idx, line in enumerate(lines[:3]):
        prefix = "“ " if idx == 0 else "  "
        suffix = " ”" if idx == len(lines[:3]) - 1 else ""
        draw.text((mx1 + 24, m_y), f"{prefix}{line}{suffix}", font=f_motto, fill=(226, 232, 240))
        m_y += 24

    # Action / Instruction Pill Badge
    ax1, ay1, ax2, ay2 = 60, 1070, W - 60, 1120
    draw.rounded_rectangle([ax1, ay1, ax2, ay2], radius=6, fill=(13, 19, 33), outline=(30, 41, 59), width=1)
    draw.text((ax1 + 20, ay1 + 16), "PANDUAN :", font=get_font(FONT_MONO, 12), fill=(0, 229, 255))
    draw.text((ax1 + 110, ay1 + 16), "Ketik !stats untuk matriks tempur lengkap atau !timerp untuk waktu benua.", font=get_font(FONT_REGULAR, 13), fill=(203, 213, 225))

    # Footer
    draw_footer(draw, "ALLYSSEA SYSTEM · PASPOR WARGA KANONIKAL")

    img.save(out_path, "PNG")
    print(f"OK:{out_path}")

def render_stats_card(data, out_path):
    img = Image.new("RGBA", (W, H), (7, 10, 18, 255))
    draw = ImageDraw.Draw(img)

    # Outer Frame
    draw.rectangle([40, 28, W - 40, H - 28], outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (40, 28, W - 40, H - 28), length=24, color=(0, 229, 255), width=3)

    # Header
    draw_header(draw, "STATUS WINDOW : TACTICAL MATRIX")

    # Name and Subtitle
    name = (data.get("name") or "Unknown").upper()
    race = data.get("race") or "Human"
    cls = data.get("className") or "Knight"
    rank = data.get("rank") or "E"
    lvl = data.get("level") or 1

    f_name = get_font(FONT_BOLD, 46)
    f_sub = get_font(FONT_MONO, 17)

    draw.text((60, 102), name, font=f_name, fill=(248, 250, 252))
    draw.text((60, 162), f"RANK {rank}  ·  LEVEL {lvl}  ·  {race.upper()} {cls.upper()}", font=f_sub, fill=(0, 229, 255))

    stats = data.get("stats") or {}
    hp = stats.get("hp", 800)
    max_hp = stats.get("maxHp", 800)
    se = stats.get("se", 200)
    max_se = stats.get("maxSe", 200)

    # Large Combat Gauges
    gx1, gy1, gx2, gy2 = 60, 205, W - 60, 375
    draw.rounded_rectangle([gx1, gy1, gx2, gy2], radius=10, fill=(11, 16, 28), outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (gx1, gy1, gx2, gy2), length=16, color=(0, 229, 255), width=2)

    f_gauge_title = get_font(FONT_BOLD, 15)
    f_gauge_lbl = get_font(FONT_MONO, 14)
    f_gauge_num = get_font(FONT_BOLD, 16)

    draw.text((gx1 + 24, gy1 + 18), "VITALITAS BINTANG (CORE GAUGES)", font=f_gauge_title, fill=(0, 229, 255))

    bar_full_w = gx2 - gx1 - 48

    # HP
    draw.text((gx1 + 24, gy1 + 50), "HP (HEALTH POINTS)", font=f_gauge_lbl, fill=(255, 75, 120))
    draw.text((gx2 - 24, gy1 + 50), f"{hp} / {max_hp}", font=f_gauge_num, fill=(248, 250, 252), anchor="ra")
    draw_segmented_bar(draw, gx1 + 24, gy1 + 74, bar_full_w, 20, hp, max_hp, (255, 42, 95), (40, 16, 28))

    # SE
    draw.text((gx1 + 24, gy1 + 106), "SE (SPIRIT ENERGY)", font=f_gauge_lbl, fill=(0, 220, 255))
    draw.text((gx2 - 24, gy1 + 106), f"{se} / {max_se}", font=f_gauge_num, fill=(248, 250, 252), anchor="ra")
    draw_segmented_bar(draw, gx1 + 24, gy1 + 130, bar_full_w, 20, se, max_se, (0, 210, 255), (14, 30, 50))

    # 8-Card Symmetrical Combat Attribute Matrix (2 cols x 4 rows)
    mx1, my1, mx2, my2 = 60, 395, W - 60, 890
    draw.rounded_rectangle([mx1, my1, mx2, my2], radius=10, fill=(11, 16, 28), outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (mx1, my1, mx2, my2), length=16, color=(56, 189, 248), width=2)

    draw.text((mx1 + 24, my1 + 18), "MATRIKS ATRIBUT TEMPUR (7 PILAR)", font=f_gauge_title, fill=(0, 229, 255))

    alloc_map = stats.get("allocatedTokens") or {}

    total_stats = (
        stats.get("str", 10) + stats.get("def", 10) + stats.get("mp", 10) +
        stats.get("res", 10) + stats.get("spd", 10) + stats.get("int", 10) + stats.get("lck", 10)
    )

    attr_list = [
        ("STR", "STRENGTH", "Fisik / Daya Rusak", stats.get("str", 10), alloc_map.get("str", 0), (0, 229, 255)),
        ("DEF", "DEFENSE", "Ketahanan / Armor", stats.get("def", 10), alloc_map.get("def", 0), (0, 229, 255)),
        ("MP",  "MAGIC POWER", "Kapasitas / Daya Sihir", stats.get("mp", 10), alloc_map.get("mp", 0), (0, 229, 255)),
        ("RES", "RESISTANCE", "Resistensi Elemen", stats.get("res", 10), alloc_map.get("res", 0), (0, 229, 255)),
        ("SPD", "SPEED / AGILITY", "Kelincahan / Refleks", stats.get("spd", 10), alloc_map.get("spd", 0), (0, 229, 255)),
        ("INT", "INTELLIGENCE", "Akurasi / Wawasan", stats.get("int", 10), alloc_map.get("int", 0), (0, 229, 255)),
        ("LCK", "LUCK / FORTUNE", "Keberuntungan / Fatalitas", stats.get("lck", 10), alloc_map.get("lck", 0), (0, 229, 255)),
        ("TOT", "TOTAL ATRIBUT", "Akumulasi Poin Stat", total_stats, 0, (234, 179, 8)),
    ]

    f_code = get_font(FONT_MONO, 20)
    f_full = get_font(FONT_BOLD, 13)
    f_desc = get_font(FONT_REGULAR, 11)
    f_val = get_font(FONT_BOLD, 26)
    f_alloc = get_font(FONT_MONO, 11)

    card_w = 385
    card_h = 88
    grid_start_x = mx1 + 24
    grid_start_y = my1 + 52

    for idx, (code, full_name, desc, val, alloc, code_col) in enumerate(attr_list):
        col = idx % 2
        row = idx // 2
        cx = grid_start_x + col * (card_w + 22)
        cy = grid_start_y + row * (card_h + 10)
        cw = card_w

        draw.rounded_rectangle([cx, cy, cx + cw, cy + card_h], radius=6, fill=(15, 23, 42), outline=(30, 41, 59), width=1)
        draw.text((cx + 16, cy + 14), code, font=f_code, fill=code_col)
        draw.text((cx + 70, cy + 15), full_name, font=f_full, fill=(241, 245, 249))
        draw.text((cx + 70, cy + 34), desc, font=f_desc, fill=(148, 163, 184))
        draw.text((cx + cw - 18, cy + 18), str(val), font=f_val, fill=(248, 250, 252), anchor="ra")

        if alloc > 0:
            draw.text((cx + cw - 18, cy + 52), f"+{alloc} ALLOC", font=f_alloc, fill=(234, 179, 8), anchor="ra")

    # Racial Trait
    trait = stats.get("trait") or "Versatility"
    rx1, ry1, rx2, ry2 = 60, 908, W - 60, 980
    draw.rounded_rectangle([rx1, ry1, rx2, ry2], radius=8, fill=(11, 16, 28), outline=(30, 41, 59), width=1)
    draw_hud_corners(draw, (rx1, ry1, rx2, ry2), length=16, color=(56, 189, 248), width=2)
    
    draw.text((rx1 + 20, ry1 + 16), "KARAKTERISTIK RASIAL", font=get_font(FONT_MONO, 11), fill=(148, 163, 184))
    draw.text((rx1 + 20, ry1 + 36), f"Inherent Trait: {trait}", font=get_font(FONT_BOLD, 16), fill=(56, 189, 248))

    # Stat Token Status Banner
    tokens = stats.get("statTokens", 0)
    tx1, ty1, tx2, ty2 = 60, 998, W - 60, 1115
    
    if tokens > 0:
        draw.rounded_rectangle([tx1, ty1, tx2, ty2], radius=8, fill=(20, 27, 45), outline=(234, 179, 8), width=2)
        draw_hud_corners(draw, (tx1, ty1, tx2, ty2), length=16, color=(251, 191, 36), width=2)
        draw.text((tx1 + 24, ty1 + 18), f"⚡ TERSEDIA {tokens} STAT TOKEN YANG BELUM DIALOKASIKAN!", font=get_font(FONT_BOLD, 16), fill=(251, 191, 36))
        draw.text((tx1 + 24, ty1 + 46), "Ketik !alokasi <stat> <jumlah> untuk meningkatkan atribut.", font=get_font(FONT_REGULAR, 14), fill=(241, 245, 249))
        draw.text((tx1 + 24, ty1 + 72), "Contoh: !alokasi str 2 atau !alokasi hp 1 (+150 HP / +100 SE / +1 Stat per token)", font=get_font(FONT_MONO, 12), fill=(148, 163, 184))
    else:
        draw.rounded_rectangle([tx1, ty1, tx2, ty2], radius=8, fill=(11, 16, 28), outline=(30, 41, 59), width=1)
        draw_hud_corners(draw, (tx1, ty1, tx2, ty2), length=16, color=(16, 185, 129), width=2)
        draw.text((tx1 + 24, ty1 + 24), "✔ SEMUA STAT TOKEN TELAH DIALOKASIKAN", font=get_font(FONT_BOLD, 15), fill=(16, 185, 129))
        draw.text((tx1 + 24, ty1 + 54), "Status atribut karakter berada pada performa optimal saat ini.", font=get_font(FONT_REGULAR, 13), fill=(148, 163, 184))

    draw_footer(draw, "ALLYSSEA SYSTEM · TACTICAL MATRIX VERIFIED")

    img.save(out_path, "PNG")
    print(f"OK:{out_path}")

def main():
    parser = argparse.ArgumentParser(description="Generate Solo-Leveling style status cards")
    parser.add_argument("--mode", choices=["character", "stats"], required=True)
    parser.add_argument("--input", required=True, help="Path to JSON payload file")
    parser.add_argument("--output", required=True, help="Path to output PNG image")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    if args.mode == "character":
        render_character_card(data, args.output)
    elif args.mode == "stats":
        render_stats_card(data, args.output)

if __name__ == "__main__":
    main()
