"""
The trophy frames for the stream overlay's pop.

RUN THIS ONLY TO REGENERATE public/trophy/*.png. The frames are committed, so
nothing at build or request time depends on Python being installed. It exists
so the strips can be rebuilt if the shape or the lighting ever needs changing,
rather than being four mystery images nobody can reproduce.

    pip install numpy pillow
    python3 tools/trophy-frames.py

Output: one strip per metal, 72 frames of a full turn, 104px square each, with
alpha. The overlay steps through them with CSS, so a browser source plays a
real 3D turn without a library, a canvas or a single line of JavaScript.

SEVENTY TWO, NOT THIRTY SIX. Thirty six frames over a six second turn is six
frames a second, and Martin called it straight away: "the trophy spin is a tad
slow so it looks like its stuttering a bit". Frame rate is the product of frame
COUNT and turn SPEED, so both moved: twice the frames, half the time, which is
twenty a second instead of six. The strips roughly double to about 110KB each,
which is nothing for a file a browser source fetches once and then reuses.

WHY NOT CSS 3D. The first attempt stacked sixteen flat copies of a trophy icon
a fraction apart in Z and spun them. Two problems, and they are both fatal.
Twelve antialiased silhouettes overlapping read as fur rather than metal, and a
full spin spends half its time showing the dim back of the stack, so there is
never a frame to read. Martin, on seeing it: "i cant see the trophy rotation
its just a blur". Fake depth was the wrong idea; this renders the depth.
"""
import numpy as np
from PIL import Image

SEG   = 44          # segments around the lathe
SS    = 3           # supersample factor
SIZE  = 104         # final frame size
FRAMES = 72

# ---------------------------------------------------------------- geometry --

def lathe(profile, seg=SEG, closed_top=True):
    """profile: list of (radius, height). Returns (verts, tris)."""
    P = np.array(profile, dtype=float)
    ang = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    cos, sin = np.cos(ang), np.sin(ang)
    verts = []
    for r, y in P:
        ring = np.stack([r * cos, np.full(seg, y), r * sin], axis=1)
        verts.append(ring)
    V = np.concatenate(verts, axis=0)
    tris = []
    for i in range(len(P) - 1):
        a = i * seg
        b = (i + 1) * seg
        for j in range(seg):
            k = (j + 1) % seg
            tris.append([a + j, b + j, b + k])
            tris.append([a + j, b + k, a + k])
    return V, np.array(tris, dtype=int)


def tube(path, radius, around=14):
    """Sweep a circle along a 3D path. Used for the handles."""
    path = np.array(path, dtype=float)
    n = len(path)
    # tangents
    T = np.gradient(path, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-9
    up = np.array([0.0, 0.0, 1.0])
    N = np.cross(T, up)
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-9
    B = np.cross(T, N)
    a = np.linspace(0, 2 * np.pi, around, endpoint=False)
    verts = []
    for i in range(n):
        ring = path[i] + radius * (np.cos(a)[:, None] * N[i] + np.sin(a)[:, None] * B[i])
        verts.append(ring)
    V = np.concatenate(verts, axis=0)
    tris = []
    for i in range(n - 1):
        p = i * around
        q = (i + 1) * around
        for j in range(around):
            k = (j + 1) % around
            tris.append([p + j, q + j, q + k])
            tris.append([p + j, q + k, p + k])
    return V, np.array(tris, dtype=int)


def build():
    # (radius, height). Outside of the cup up to the rim, then back down the
    # inside, so the bowl is genuinely hollow when you see into it.
    prof = [
        (0.00, 0.000), (0.46, 0.000), (0.46, 0.050),          # base plate
        (0.42, 0.070), (0.30, 0.098),
        (0.115, 0.135), (0.105, 0.300),                        # stem
        (0.20, 0.330), (0.135, 0.365),                         # knob
        (0.175, 0.400), (0.30, 0.470), (0.395, 0.560),         # bowl outside
        (0.455, 0.660), (0.485, 0.770), (0.495, 0.880),
        (0.500, 0.960), (0.470, 0.965),                        # rim
        (0.455, 0.880), (0.430, 0.760), (0.375, 0.640),        # bowl inside
        (0.270, 0.530), (0.140, 0.450), (0.00, 0.430),
    ]
    V, T = lathe(prof)

    # two handles, arcs in the XY plane at either side
    parts = [(V, T)]
    for side in (-1, 1):
        t = np.linspace(-1.15, 1.15, 26)
        cx, cy, rr = side * 0.50, 0.735, 0.235
        path = np.stack([
            cx + side * rr * np.cos(t) * 0.95,
            cy + rr * np.sin(t) * 1.15,
            np.zeros_like(t),
        ], axis=1)
        parts.append(tube(path, 0.055))

    verts, tris, off = [], [], 0
    for v, t in parts:
        verts.append(v)
        tris.append(t + off)
        off += len(v)
    return np.concatenate(verts), np.concatenate(tris)


VERTS, TRIS = build()
VERTS[:, 1] -= 0.48          # centre it on the origin
print('tris', len(TRIS))

# ---------------------------------------------------------------- shading --

def normals(V, T):
    n = np.zeros_like(V)
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    fn = np.cross(b - a, c - a)
    for i in range(3):
        np.add.at(n, T[:, i], fn)
    return n / (np.linalg.norm(n, axis=1, keepdims=True) + 1e-9)


NORMS = normals(VERTS, TRIS)

KEY  = np.array([-0.45, 0.72, 0.72]); KEY /= np.linalg.norm(KEY)
RIM  = np.array([0.72, 0.15, -0.62]); RIM /= np.linalg.norm(RIM)
VIEW = np.array([0.0, 0.0, 1.0])


def shade(nrm, base, spec_tint):
    """Metal: a hard key, a rim behind, and a sky-to-floor gradient that stands
    in for an environment. The gradient is what makes it read as metal rather
    than as plastic."""
    ndl = np.clip(nrm @ KEY, 0, 1)
    ndr = np.clip(nrm @ RIM, 0, 1)
    env = 0.5 + 0.5 * nrm[:, 1]                     # up is bright, down is dark
    h = KEY + VIEW; h /= np.linalg.norm(h)
    spec = np.clip(nrm @ h, 0, 1) ** 42
    spec2 = np.clip(nrm @ ((RIM + VIEW) / np.linalg.norm(RIM + VIEW)), 0, 1) ** 20

    amb = 0.20 + 0.42 * env
    lit = amb + 0.80 * ndl + 0.30 * ndr ** 2
    col = base[None, :] * lit[:, None]
    col += spec_tint[None, :] * (1.15 * spec + 0.45 * spec2)[:, None]
    return np.clip(col, 0, 1)


# ---------------------------------------------------------------- raster ---

def render(angle, base, spec_tint):
    R = SIZE * SS
    ca, sa = np.cos(angle), np.sin(angle)
    Ry = np.array([[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]])
    tilt = np.radians(9)
    ct, st = np.cos(tilt), np.sin(tilt)
    Rx = np.array([[1, 0, 0], [0, ct, -st], [0, st, ct]])
    M = Rx @ Ry

    V = VERTS @ M.T
    N = NORMS @ M.T
    col = shade(N, base, spec_tint)

    z = V[:, 2] + 4.2
    f = 3.35 * R / 2
    x = V[:, 0] * f / z + R / 2
    y = R / 2 - V[:, 1] * f / z

    zbuf = np.full((R, R), 1e9)
    img = np.zeros((R, R, 3))
    hit = np.zeros((R, R), bool)

    a, b, c = TRIS[:, 0], TRIS[:, 1], TRIS[:, 2]
    # backface cull in screen space
    area = (x[b] - x[a]) * (y[c] - y[a]) - (x[c] - x[a]) * (y[b] - y[a])
    keep = area < -1e-9
    idx = np.nonzero(keep)[0]

    for t in idx:
        i0, i1, i2 = TRIS[t]
        xs = np.array([x[i0], x[i1], x[i2]])
        ys = np.array([y[i0], y[i1], y[i2]])
        x0, x1 = int(max(0, np.floor(xs.min()))), int(min(R - 1, np.ceil(xs.max())))
        y0, y1 = int(max(0, np.floor(ys.min()))), int(min(R - 1, np.ceil(ys.max())))
        if x1 < x0 or y1 < y0:
            continue
        px = np.arange(x0, x1 + 1) + 0.5
        py = np.arange(y0, y1 + 1) + 0.5
        PX, PY = np.meshgrid(px, py)
        d = area[t]
        w0 = ((xs[1] - xs[0]) * (PY - ys[0]) - (PX - xs[0]) * (ys[1] - ys[0])) / d
        w1 = ((xs[2] - xs[1]) * (PY - ys[1]) - (PX - xs[1]) * (ys[2] - ys[1])) / d
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        # barycentric order: w1 -> v0, w2 -> v1, w0 -> v2
        zz = w1 * z[i0] + w2 * z[i1] + w0 * z[i2]
        sub = zbuf[y0:y1 + 1, x0:x1 + 1]
        take = inside & (zz < sub)
        if not take.any():
            continue
        cc = (w1[..., None] * col[i0] + w2[..., None] * col[i1] + w0[..., None] * col[i2])
        sub[take] = zz[take]
        tile = img[y0:y1 + 1, x0:x1 + 1]
        tile[take] = cc[take]
        hit[y0:y1 + 1, x0:x1 + 1][take] = True

    rgba = np.dstack([img, hit.astype(float)])
    im = Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), 'RGBA')
    return im.resize((SIZE, SIZE), Image.LANCZOS)


METALS = {
    'plat':   (np.array([0.52, 0.66, 0.92]), np.array([0.85, 0.93, 1.00])),
    'gold':   (np.array([0.74, 0.55, 0.13]), np.array([1.00, 0.93, 0.68])),
    'silver': (np.array([0.62, 0.66, 0.70]), np.array([1.00, 1.00, 1.00])),
    'bronze': (np.array([0.64, 0.38, 0.18]), np.array([1.00, 0.82, 0.62])),
}

for name, (base, spec) in METALS.items():
    strip = Image.new('RGBA', (SIZE * FRAMES, SIZE), (0, 0, 0, 0))
    for i in range(FRAMES):
        strip.paste(render(2 * np.pi * i / FRAMES, base, spec), (i * SIZE, 0))
    strip.save(f'public/trophy/{name}.png')
    print(name, 'done')
