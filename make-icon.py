#!/usr/bin/env python3
"""生成 1024x1024 应用图标：圆角方块 + 三行笔记条"""
import math
import struct
import zlib

S = 1024
SS = 2  # 每像素 2x2 超采样


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    dx = abs(px - cx) - hw + r
    dy = abs(py - cy) - hh + r
    ax = max(dx, 0.0)
    ay = max(dy, 0.0)
    return math.sqrt(ax * ax + ay * ay) + min(max(dx, dy), 0.0) - r


def lerp(a, b, t):
    return a + (b - a) * t


def pixel(x, y):
    """返回 (r,g,b,a) 0-255"""
    r = g = b = 0.0
    a = 0.0

    # 外框圆角方块
    d = sd_round_rect(x, y, 512, 512, 448, 448, 224)
    if d < 0:
        t = (y - 64) / 896
        t = max(0.0, min(1.0, t))
        r, g, b = lerp(212, 168, t), lerp(116, 72, t), lerp(76, 40, t)
        a = 255.0

    # 三行白色笔记条
    bars = [
        (250, 774, 370, 46),
        (250, 774, 500, 46),
        (250, 640, 630, 46),
    ]
    for x0, x1, yc, h in bars:
        bw = (x1 - x0) / 2
        dd = sd_round_rect(x, y, (x0 + x1) / 2, yc, bw, h / 2, h / 2)
        if dd < 0:
            alpha = 0.95
            r = lerp(r, 255, alpha)
            g = lerp(g, 252, alpha)
            b = lerp(b, 248, alpha)

    return int(r), int(g), int(b), int(a)


def build():
    rows = []
    inv = 1.0 / (SS * SS)
    for y in range(S):
        row = bytearray()
        row.append(0)  # filter type 0
        for x in range(S):
            ar = ag = ab = aa = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    r, g, b, a = pixel(px, py)
                    ar += r * a
                    ag += g * a
                    ab += b * a
                    aa += a
            if aa == 0:
                row.extend((0, 0, 0, 0))
            else:
                row.extend(
                    (
                        int(ar / aa),
                        int(ag / aa),
                        int(ab / aa),
                        int(aa * inv),
                    )
                )
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


raw = build()
png = b"\x89PNG\r\n\x1a\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(raw, 9))
png += chunk(b"IEND", b"")

with open("src-icon.png", "wb") as f:
    f.write(png)

print(f"written src-icon.png  {len(png)/1024:.1f} KB")
