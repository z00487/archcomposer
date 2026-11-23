"""�net审图：把 demohall.geometry.json 用简单正交投影画成 PNG，用于肉眼检查几何形状。

不是交付物，只是自查工具。用法：
    python3 preview.py <geometry.json> <out.png>
"""
import io
import json
import math
import sys

from PIL import Image, ImageDraw

GEO = sys.argv[1]
OUT = sys.argv[2]

data = json.load(io.open(GEO, encoding="utf-8"))

# ── 等轴测投影（+X 东向右、+Y 上、+Z 南向左下） ──────────────────────
AZ = math.radians(38)   # 绕 Y 轴的方位角
EL = math.radians(22)   # 仰角
COS_A, SIN_A = math.cos(AZ), math.sin(AZ)
COS_E, SIN_E = math.cos(EL), math.sin(EL)


def project(p):
    """等轴测投影：返回屏幕 (x, y) 两维坐标。"""
    x, y, z = p
    rx = x * COS_A + z * SIN_A
    rz = -x * SIN_A + z * COS_A
    return rx, y * COS_E - rz * SIN_E


def depth_of(p):
    """画家算法用的深度：越大越靠近观察者。"""
    x, y, z = p
    return (-x * SIN_A + z * COS_A) * COS_E + y * SIN_E


COLORS = {
    "stone": (185, 179, 167),
    "wood": (169, 105, 60),
    "woodDark": (122, 70, 42),
    "roofTile": (75, 85, 99),
    "wall": (216, 210, 198),
    "ridge": (58, 66, 77),
}


def box_verts(cx, cy, cz, sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    return [
        (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy - hy, cz + hz), (cx - hx, cy - hy, cz + hz),
        (cx - hx, cy + hy, cz - hz), (cx + hx, cy + hy, cz - hz),
        (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
    ]


BOX_FACES = [
    (0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
    (2, 3, 7, 6), (1, 2, 6, 5), (0, 3, 7, 4),
]


def cylinder_verts(cx, cy, cz, r, h, axis, seg=12):
    """圆柱按轴展开成两圈顶点，用四边形连接。"""
    rings = []
    for k in (0, 1):
        ring = []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            a, b = r * math.cos(t), r * math.sin(t)
            if axis == "y":
                ring.append((cx + a, cy + (k - 0.5) * h, cz + b))
            elif axis == "x":
                ring.append((cx + (k - 0.5) * h, cy + a, cz + b))
            else:
                ring.append((cx + a, cy + b, cz + (k - 0.5) * h))
        rings.append(ring)
    return rings


def prism_verts(cx, cy, cz, base, height, thickness):
    hb, hh, ht = base / 2, height / 2, thickness / 2
    return [
        (cx - ht, cy - hh, cz - hb), (cx - ht, cy - hh, cz + hb), (cx - ht, cy + hh, cz),
        (cx + ht, cy - hh, cz - hb), (cx + ht, cy - hh, cz + hb), (cx + ht, cy + hh, cz),
    ]


PRISM_FACES = [(0, 1, 2), (3, 4, 5), (0, 2, 5, 3), (1, 2, 5, 4), (0, 1, 4, 3)]


def rot_x(deg):
    c, s = math.cos(deg), math.sin(deg)
    return lambda p: (p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c)


polys = []  # (depth, points, color)

for c in data["components"]:
    sh = c["shape"]
    px, py, pz = c["position"]
    col = COLORS.get(c["materialKey"], (150, 150, 150))
    if sh["form"] == "box":
        vs = box_verts(px, py, pz, sh["size"][0], sh["size"][1], sh["size"][2])
        faces = BOX_FACES
    elif sh["form"] == "cylinder":
        rings = cylinder_verts(px, py, pz, sh["radius"], sh["height"], sh["axis"])
        vs = rings[0] + rings[1]
        n = len(rings[0])
        faces = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        faces += [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    else:  # prism
        vs = prism_verts(px, py, pz, sh["base"], sh["height"], sh["thickness"])
        faces = PRISM_FACES

    # 应用运行时会施加的绕 X 倾角（领域层已算好，写在 rotX 里）
    rx = c.get("rotX", 0.0)
    if rx:
        r = rot_x(rx)
        cx0, cy0, cz0 = px, py, pz
        vs = [
            tuple(a + b for a, b in zip((cx0, cy0, cz0), r((v[0] - cx0, v[1] - cy0, v[2] - cz0))))
            for v in vs
        ]

    proj = [project(v) for v in vs]
    for f in faces:
        pts = [proj[i] for i in f]
        depth = sum(depth_of(vs[i]) for i in f) / len(f)
        polys.append((depth, pts, col))

polys.sort(key=lambda t: t[0])

xs = [p[0] for _, pts, _ in polys for p in pts]
ys = [p[1] for _, pts, _ in polys for p in pts]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
pad = 30
scale = min((1100 - 2 * pad) / max(maxx - minx, 1e-6), (820 - 2 * pad) / max(maxy - miny, 1e-6))
W = int((maxx - minx) * scale) + 2 * pad
H = int((maxy - miny) * scale) + 2 * pad
img = Image.new("RGB", (W, H), (238, 243, 247))
d = ImageDraw.Draw(img)

for _, pts, col in polys:
    xy = [(pad + (x - minx) * scale, H - pad - (y - miny) * scale) for x, y in pts]
    d.polygon(xy, fill=col, outline=(90, 90, 90))

img.save(OUT)
print(f"写出 {OUT}  {W}x{H}  多边形 {len(polys)}")
