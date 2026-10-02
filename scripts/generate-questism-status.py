import os
import math
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def generate_questism_status(output_path='/sdcard/Download/test_questism_stats_master_v3.png'):
    dest_dir = '/root/projects/Allybot/assets/questism'
    font_degres = os.path.join(dest_dir, 'fonts', 'degres-sans.ttf')
    font_noodle = os.path.join(dest_dir, 'fonts', 'bignoodletitlingrusbydaymarius.ttf')

    # 1. Canvas 1536 x 2048
    canvas_w, canvas_h = 1536, 2048
    canvas = Image.new('RGBA', (canvas_w, canvas_h), (7, 13, 24, 255))
    draw = ImageDraw.Draw(canvas)

    # Dimmed background digital grid
    grid_color = (0, 229, 255, 9)
    for x in range(0, canvas_w, 48):
        draw.line([(x, 0), (x, canvas_h)], fill=grid_color, width=1)
    for y in range(0, canvas_h, 48):
        draw.line([(0, y), (canvas_w, y)], fill=grid_color, width=1)

    # Subtle ambient cyan aura in the center
    aura = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    aura_draw = ImageDraw.Draw(aura)
    aura_draw.ellipse([200, 300, 1336, 1750], fill=(0, 160, 255, 30))
    aura = aura.filter(ImageFilter.GaussianBlur(150))
    canvas = Image.alpha_composite(canvas, aura)
    draw = ImageDraw.Draw(canvas)

    # Fonts (Strictly >= 26 px, zero text < 22 px)
    f_title = ImageFont.truetype(font_noodle, 72)
    f_name = ImageFont.truetype(font_noodle, 68)
    f_sub = ImageFont.truetype(font_degres, 28)
    f_badge_title = ImageFont.truetype(font_degres, 28)
    f_status = ImageFont.truetype(font_degres, 28)
    f_bio_lbl = ImageFont.truetype(font_noodle, 30)
    f_bio_val = ImageFont.truetype(font_degres, 30)
    f_stat_lbl = ImageFont.truetype(font_noodle, 32)
    f_stat_num = ImageFont.truetype(font_degres, 36)
    f_rank = ImageFont.truetype(font_degres, 40)
    f_radar_lbl = ImageFont.truetype(font_degres, 34)
    f_analytics_head = ImageFont.truetype(font_noodle, 36)
    f_analytics_title = ImageFont.truetype(font_noodle, 28)
    f_analytics_val = ImageFont.truetype(font_degres, 32)
    f_analytics_sub = ImageFont.truetype(font_degres, 26)
    f_alert = ImageFont.truetype(font_noodle, 36)
    f_footer = ImageFont.truetype(font_degres, 28)

    # Helper: Draw Chamfered HUD Container
    def draw_hud_box(d, box, fill=(11, 20, 35, 235), outline=(0, 229, 255, 180), chamfer=16, corner_accent=True):
        x1, y1, x2, y2 = box
        pts = [
            (x1 + chamfer, y1),
            (x2 - chamfer, y1),
            (x2, y1 + chamfer),
            (x2, y2 - chamfer),
            (x2 - chamfer, y2),
            (x1 + chamfer, y2),
            (x1, y2 - chamfer),
            (x1, y1 + chamfer),
        ]
        d.polygon(pts, fill=fill, outline=outline)
        
        if corner_accent:
            c_len = 20
            d.line([(x1 - 3, y1 - 3), (x1 + c_len, y1 - 3)], fill=(0, 229, 255, 255), width=3)
            d.line([(x1 - 3, y1 - 3), (x1 - 3, y1 + c_len)], fill=(0, 229, 255, 255), width=3)
            d.line([(x2 + 3, y1 - 3), (x2 - c_len, y1 - 3)], fill=(0, 229, 255, 255), width=3)
            d.line([(x2 + 3, y1 - 3), (x2 + 3, y1 + c_len)], fill=(0, 229, 255, 255), width=3)
            d.line([(x1 - 3, y2 + 3), (x1 + c_len, y2 + 3)], fill=(0, 229, 255, 255), width=3)
            d.line([(x1 - 3, y2 + 3), (x1 - 3, y2 - c_len)], fill=(0, 229, 255, 255), width=3)
            d.line([(x2 + 3, y2 + 3), (x2 - c_len, y2 + 3)], fill=(0, 229, 255, 255), width=3)
            d.line([(x2 + 3, y2 + 3), (x2 + 3, y2 - c_len)], fill=(0, 229, 255, 255), width=3)

    # 1. Top Header & Diamond Divider
    draw.text((canvas_w // 2, 70), "STATUS WINDOW", font=f_title, fill=(0, 229, 255, 255), anchor="mm")

    div_y = 115
    div_w = 420
    cx = canvas_w // 2
    draw.line([(cx - div_w, div_y), (cx - 16, div_y)], fill=(0, 229, 255, 140), width=2)
    draw.line([(cx + 16, div_y), (cx + div_w, div_y)], fill=(0, 229, 255, 140), width=2)
    d_rad = 8
    draw.polygon([
        (cx, div_y - d_rad),
        (cx + d_rad, div_y),
        (cx, div_y + d_rad),
        (cx - d_rad, div_y)
    ], fill=(0, 229, 255, 255))
    draw.circle((cx - div_w - 6, div_y), 3, fill=(0, 229, 255, 180))
    draw.circle((cx + div_w + 6, div_y), 3, fill=(0, 229, 255, 180))

    # 2. Hero Nameplate Banner (y = 145 .. 305)
    hero_box = [140, 145, 1396, 305]
    draw_hud_box(draw, hero_box, fill=(10, 18, 32, 240), outline=(0, 229, 255, 160), chamfer=16)

    draw.text((180, 190), "CYRUS ALVALEN", font=f_name, fill=(255, 255, 255, 255), anchor="lm")

    badge_box = [620, 172, 880, 208]
    draw.rounded_rectangle(badge_box, radius=4, fill=(35, 26, 12, 230), outline=(180, 120, 20, 200), width=1)
    draw.text(((badge_box[0] + badge_box[2]) // 2, 190), "GANGBUK WEST NO. 1", font=f_badge_title, fill=(225, 175, 45, 255), anchor="mm")

    draw.text((180, 260), "VAMPIRE · SHADOW ASSASSIN  |  LEVEL 25", font=f_sub, fill=(0, 229, 255, 230), anchor="lm")
    draw.text((1356, 225), "STATUS: NORMAL · NO DEBUFF", font=f_status, fill=(74, 222, 128, 255), anchor="rm")

    # 3. Avatar & Biometrics Section (y = 335 .. 685, height 350)
    av_box = [140, 335, 620, 685]
    draw_hud_box(draw, av_box, fill=(8, 15, 28, 245), outline=(0, 229, 255, 180), chamfer=14)

    av_portrait = Image.open('/tmp/avatar_vampire_final.png').convert('RGBA')
    av_portrait = av_portrait.resize((454, 326), Image.Resampling.LANCZOS)
    canvas.paste(av_portrait, (153, 347), av_portrait)
    draw = ImageDraw.Draw(canvas)

    bio_box = [650, 335, 1396, 685]
    draw_hud_box(draw, bio_box, fill=(10, 18, 32, 240), outline=(0, 229, 255, 150), chamfer=14)

    draw.text((680, 368), "PHYSICAL PARAMETERS & REGISTRATION", font=ImageFont.truetype(font_noodle, 30), fill=(0, 229, 255, 230), anchor="lm")
    draw.line([(680, 390), (1366, 390)], fill=(0, 229, 255, 70), width=1)

    bio_rows = [
        ("HEIGHT", "182 CM", (0, 229, 255), "WEIGHT", "74 KG", (0, 229, 255)),
        ("TIER", "RANK S", (234, 179, 8), "RANKING", "NO. 1 (WEST)", (234, 179, 8)),
        ("RACE", "PURE VAMPIRE", (251, 113, 133), "ROLE", "SHADOW VANGUARD", (248, 250, 252)),
        ("CREW", "GANGBUK", (74, 222, 128), "AFFINITY", "SHADOW · SOUL STABLE", (56, 189, 248)),
    ]

    bio_y_starts = [430, 495, 560, 625]
    for idx, (l1, v1, c1, l2, v2, c2) in enumerate(bio_rows):
        by = bio_y_starts[idx]
        draw.text((685, by), f"{l1} :", font=f_bio_lbl, fill=(255, 255, 255, 255), anchor="lm")
        draw.text((820, by), v1, font=f_bio_val, fill=c1, anchor="lm")
        draw.text((1000, by), f"{l2} :", font=f_bio_lbl, fill=(255, 255, 255, 255), anchor="lm")
        draw.text((1140, by), v2, font=f_bio_val, fill=c2, anchor="lm")

    # 4. The 10 Combat Stats (y = 715 .. 1245, height 530)
    stat_pairs = [
        ("STRENGTH", 145, "SSS", (239, 68, 68),
         "DEFENSE", 95, "S", (234, 179, 8)),
        ("SPEED", 128, "SS+", (249, 115, 22),
         "RESISTANCE", 60, "A", (56, 189, 248)),
        ("POTENTIAL", 110, "S+", (234, 179, 8),
         "MAGIC POWER", 85, "S", (234, 179, 8)),
        ("INTELLIGENCE", 65, "A+", (56, 189, 248),
         "LUCK", 25, "C+", (74, 222, 128)),
        ("ENDURANCE", 138, "SSS", (239, 68, 68),
         "WILLPOWER", 100, "S+", (234, 179, 8)),
    ]

    bar_total_w = 210
    bar_h = 16
    rank_ticks = [30, 60, 80, 100, 120, 140]
    row_y_starts = [715, 821, 927, 1033, 1139]

    for r_i, (l_name, l_val, l_rank, l_col, r_name, r_val, r_rank, r_col) in enumerate(stat_pairs):
        ry = row_y_starts[r_i]
        cy = ry + 44
        
        l_box = [140, ry, 750, ry + 88]
        draw.rounded_rectangle(l_box, radius=8, fill=(12, 22, 38, 240), outline=(0, 229, 255, 60), width=1)
        r_box = [786, ry, 1396, ry + 88]
        draw.rounded_rectangle(r_box, radius=8, fill=(12, 22, 38, 240), outline=(0, 229, 255, 60), width=1)
        
        draw.text((160, cy), l_name, font=f_stat_lbl, fill=(255, 255, 255, 255), anchor="lm")
        draw.text((365, cy), str(l_val), font=f_stat_num, fill=(248, 250, 252, 255), anchor="lm")
        draw.text((466, cy + 1), l_rank, font=f_rank, fill=(0, 0, 0, 255), anchor="mm")
        draw.text((465, cy), l_rank, font=f_rank, fill=l_col, anchor="mm")
        
        bar_x = 515
        bar_y = cy - (bar_h // 2)
        draw.rectangle([bar_x, bar_y, bar_x + bar_total_w, bar_y + bar_h], fill=(22, 32, 50, 255), outline=(40, 60, 90, 255), width=1)
        fill_w = int((l_val / 150.0) * bar_total_w)
        draw.rectangle([bar_x, bar_y, bar_x + fill_w, bar_y + bar_h], fill=l_col)
        for tk in rank_ticks:
            tx = bar_x + int((tk / 150.0) * bar_total_w)
            draw.line([(tx, bar_y), (tx, bar_y + bar_h)], fill=(15, 23, 42, 200), width=1)
            
        draw.text((806, cy), r_name, font=f_stat_lbl, fill=(255, 255, 255, 255), anchor="lm")
        draw.text((1011, cy), str(r_val), font=f_stat_num, fill=(248, 250, 252, 255), anchor="lm")
        draw.text((1112, cy + 1), r_rank, font=f_rank, fill=(0, 0, 0, 255), anchor="mm")
        draw.text((1111, cy), r_rank, font=f_rank, fill=r_col, anchor="mm")
        
        bar_x_r = 1161
        draw.rectangle([bar_x_r, bar_y, bar_x_r + bar_total_w, bar_y + bar_h], fill=(22, 32, 50, 255), outline=(40, 60, 90, 255), width=1)
        fill_w_r = int((r_val / 150.0) * bar_total_w)
        draw.rectangle([bar_x_r, bar_y, bar_x_r + fill_w_r, bar_y + bar_h], fill=r_col)
        for tk in rank_ticks:
            tx = bar_x_r + int((tk / 150.0) * bar_total_w)
            draw.line([(tx, bar_y), (tx, bar_y + bar_h)], fill=(15, 23, 42, 200), width=1)

    # 5. Data-Derived Analytics Panel (y = 1275 .. 1795, height 520)
    analytics_box = [140, 1275, 1396, 1795]
    draw_hud_box(draw, analytics_box, fill=(9, 17, 30, 245), outline=(0, 229, 255, 170), chamfer=16)

    draw.text((180, 1307), "COMBAT STAT ANALYTICS & RADAR MATRIX", font=f_analytics_head, fill=(0, 229, 255, 255), anchor="lm")
    draw.line([(180, 1326), (1356, 1326)], fill=(0, 229, 255, 80), width=1)

    radar_cx = 445
    radar_cy = 1560
    R_max = 155

    stats_radar_data = [
        ("STR", 145, (239, 68, 68)),
        ("SPD", 128, (249, 115, 22)),
        ("POT", 110, (234, 179, 8)),
        ("INT", 65, (56, 189, 248)),
        ("END", 138, (239, 68, 68)),
        ("WIL", 100, (234, 179, 8)),
        ("LCK", 25, (74, 222, 128)),
        ("MAG", 85, (234, 179, 8)),
        ("RES", 60, (56, 189, 248)),
        ("DEF", 95, (234, 179, 8)),
    ]
    num_stats = len(stats_radar_data)

    ring_scales = [30, 60, 90, 120, 150]
    for rs in ring_scales:
        r_px = (rs / 150.0) * R_max
        ring_pts = []
        for i in range(num_stats):
            angle = -math.pi / 2 + i * (2 * math.pi / num_stats)
            rx = radar_cx + r_px * math.cos(angle)
            ry = radar_cy + r_px * math.sin(angle)
            ring_pts.append((rx, ry))
        draw.polygon(ring_pts, outline=(0, 229, 255, 45 if rs < 150 else 100), width=1)

    for i in range(num_stats):
        angle = -math.pi / 2 + i * (2 * math.pi / num_stats)
        rx = radar_cx + R_max * math.cos(angle)
        ry = radar_cy + R_max * math.sin(angle)
        draw.line([(radar_cx, radar_cy), (rx, ry)], fill=(0, 229, 255, 55), width=1)

    poly_pts = []
    for i, (name, val, col) in enumerate(stats_radar_data):
        angle = -math.pi / 2 + i * (2 * math.pi / num_stats)
        r_val_px = (val / 150.0) * R_max
        px = radar_cx + r_val_px * math.cos(angle)
        py = radar_cy + r_val_px * math.sin(angle)
        poly_pts.append((px, py))

    radar_poly_layer = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    r_poly_draw = ImageDraw.Draw(radar_poly_layer)
    r_poly_draw.polygon(poly_pts, fill=(0, 229, 255, 65), outline=(0, 229, 255, 230))
    canvas = Image.alpha_composite(canvas, radar_poly_layer)
    draw = ImageDraw.Draw(canvas)

    for i, (name, val, col) in enumerate(stats_radar_data):
        angle = -math.pi / 2 + i * (2 * math.pi / num_stats)
        px, py = poly_pts[i]
        draw.circle((px, py), 6, fill=col, outline=(255, 255, 255, 255), width=1)
        
        lbl_dist = R_max + 28
        lx = radar_cx + lbl_dist * math.cos(angle)
        ly = radar_cy + lbl_dist * math.sin(angle)
        
        if abs(math.cos(angle)) < 0.2:
            anch = "ms" if math.sin(angle) < 0 else "ma"
        elif math.cos(angle) > 0:
            anch = "lm"
        else:
            anch = "rm"
            
        draw.text((lx, ly), f"{name} {val}", font=f_radar_lbl, fill=col, anchor=anch)

    draw.circle((radar_cx, radar_cy), 3, fill=(0, 229, 255, 255))

    stat_sum_box = [780, 1360, 1366, 1760]
    draw.rounded_rectangle(stat_sum_box, radius=8, fill=(13, 23, 40, 220), outline=(0, 229, 255, 80), width=1)

    summary_lines = [
        ("TOTAL STAT POOL", "951 / 1500", (0, 229, 255), "Tier: Rank S Overcharge"),
        ("PEAK ATTRIBUTE", "STRENGTH (145)", (239, 68, 68), "Grade: SSS · Peak Lethality"),
        ("BASE ATTRIBUTE", "LUCK (25)", (74, 222, 128), "Grade: C+ · High Potential Growth"),
        ("COMBAT EFFICIENCY", "95.1 AVG STAT", (234, 179, 8), "Domain Authority: Dominant"),
    ]

    s_y_starts = [1385, 1480, 1575, 1670]
    for idx, (title, val_str, val_col, sub_desc) in enumerate(summary_lines):
        sy = s_y_starts[idx]
        draw.text((805, sy), title, font=f_analytics_title, fill=(255, 255, 255, 255), anchor="lm")
        draw.text((1340, sy), val_str, font=f_analytics_val, fill=val_col, anchor="rm")
        draw.text((805, sy + 34), sub_desc, font=f_analytics_sub, fill=(241, 245, 249, 255), anchor="lm")
        if idx < 3:
            draw.line([(805, sy + 66), (1340, sy + 66)], fill=(0, 229, 255, 50), width=1)

    # 6. Unassigned Stat Points Banner (y = 1820 .. 1920)
    gold_box = [140, 1820, 1396, 1920]
    draw_hud_box(draw, gold_box, fill=(24, 18, 8, 245), outline=(234, 179, 8, 220), chamfer=14)

    alert_str = "5 UNASSIGNED STAT POINTS REMAINING · POTENTIAL UNLOCKED"
    str_bbox = f_alert.getbbox(alert_str)
    str_w = str_bbox[2] - str_bbox[0]
    badge_center_x = canvas_w // 2
    lt_x = badge_center_x - (str_w // 2) - 30
    lt_y = 1870

    draw.polygon([
        (lt_x, lt_y - 18),
        (lt_x - 12, lt_y + 2),
        (lt_x - 2, lt_y + 2),
        (lt_x - 6, lt_y + 20),
        (lt_x + 12, lt_y - 2),
        (lt_x + 2, lt_y - 2),
    ], fill=(255, 215, 0, 255))

    draw.text((badge_center_x + 10, lt_y), alert_str, font=f_alert, fill=(255, 215, 0, 255), anchor="mm")

    # 7. Polished Footer (y = 1960)
    footer_str = "◈ ALLYSSEA ROLEPLAY COMMUNITY · QUESTISM SYSTEM ENGINE ◈"
    draw.text((canvas_w // 2, 1960), footer_str, font=f_footer, fill=(241, 245, 249, 255), anchor="mm")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    canvas.save(output_path)
    return output_path

if __name__ == '__main__':
    generate_questism_status()
