"""Deterministic vectorised noise for the premium asset pipeline (numpy only).

All functions take coordinate arrays in metres and return float32/float64 arrays.
Everything is seeded; there is no global RNG state, so a build is reproducible.
"""
import numpy as np

_U = np.uint32


def _hash(ix, iy, iz, seed):
    with np.errstate(over='ignore'):
        h = (ix.astype(np.int64).astype(np.uint32) * _U(0x8DA6B343)) ^ (iy.astype(np.int64).astype(np.uint32) * _U(0xD8163841)) \
            ^ (iz.astype(np.int64).astype(np.uint32) * _U(0xCB1AB31F)) ^ _U((int(seed) * 0x9E3779B1) & 0xFFFFFFFF)
        h ^= h >> _U(15)
        h *= _U(0x2C1B3C6D)
        h ^= h >> _U(12)
        h *= _U(0x297A2D39)
        h ^= h >> _U(15)
    return h


def _unit(h):
    return h.astype(np.float64) / 4294967295.0


def hash01(ix, iy=None, iz=None, seed=0):
    """Uniform [0, 1) value per integer lattice point."""
    ix = np.asarray(ix)
    iy = np.zeros_like(ix) if iy is None else np.asarray(iy)
    iz = np.zeros_like(ix) if iz is None else np.asarray(iz)
    return _unit(_hash(ix, iy, iz, seed))


def vnoise(x, y, z=None, seed=0):
    """Smooth value noise in [0, 1]."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    z = np.zeros_like(x) if z is None else np.asarray(z, dtype=np.float64)
    x, y, z = np.broadcast_arrays(x, y, z)
    xi, yi, zi = np.floor(x), np.floor(y), np.floor(z)
    fx, fy, fz = x - xi, y - yi, z - zi
    ux, uy, uz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    xi, yi, zi = xi.astype(np.int64), yi.astype(np.int64), zi.astype(np.int64)

    def c(dx, dy, dz):
        return _unit(_hash(xi + dx, yi + dy, zi + dz, seed))

    x00 = c(0, 0, 0) * (1 - ux) + c(1, 0, 0) * ux
    x10 = c(0, 1, 0) * (1 - ux) + c(1, 1, 0) * ux
    x01 = c(0, 0, 1) * (1 - ux) + c(1, 0, 1) * ux
    x11 = c(0, 1, 1) * (1 - ux) + c(1, 1, 1) * ux
    y0 = x00 * (1 - uy) + x10 * uy
    y1 = x01 * (1 - uy) + x11 * uy
    return y0 * (1 - uz) + y1 * uz


def fbm(x, y, z=None, octaves=5, lacunarity=2.03, gain=0.5, seed=0):
    """Fractal sum in roughly [-1, 1] (zero mean)."""
    total = 0.0
    amp = 1.0
    norm = 0.0
    fx = 1.0
    for o in range(octaves):
        # Offset each octave so lattice alignment does not stack.
        off = 17.31 * (o + 1)
        n = vnoise(np.asarray(x) * fx + off, np.asarray(y) * fx - off * 0.7, None if z is None else np.asarray(z) * fx + off * 0.37, seed + o * 101)
        total = total + amp * (n * 2 - 1)
        norm += amp
        amp *= gain
        fx *= lacunarity
    return total / norm


def worley2(x, y, seed=0, jitter=0.9):
    """2D cellular noise. Returns (F1, F2, cell_id01, nearest_x, nearest_y) with unit cell size."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    x, y = np.broadcast_arrays(x, y)
    xi, yi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    f1 = np.full(x.shape, 9.0)
    f2 = np.full(x.shape, 9.0)
    cid = np.zeros(x.shape)
    nx_ = np.zeros(x.shape)
    ny_ = np.zeros(x.shape)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            cx, cy = xi + dx, yi + dy
            z0 = np.zeros_like(cx)
            px = cx + 0.5 + (hash01(cx, cy, z0, seed) - 0.5) * jitter
            py = cy + 0.5 + (hash01(cx, cy, z0, seed + 7) - 0.5) * jitter
            d = np.hypot(px - x, py - y)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            cid = np.where(closer, hash01(cx, cy, z0, seed + 13), cid)
            nx_ = np.where(closer, px, nx_)
            ny_ = np.where(closer, py, ny_)
            f1 = np.where(closer, d, f1)
    return f1, f2, cid, nx_, ny_


def worley3(x, y, z, seed=0, jitter=0.9):
    """3D cellular noise (F1, F2) with unit cells."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    z = np.asarray(z, dtype=np.float64)
    x, y, z = np.broadcast_arrays(x, y, z)
    xi, yi, zi = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64), np.floor(z).astype(np.int64)
    f1 = np.full(x.shape, 9.0)
    f2 = np.full(x.shape, 9.0)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cx, cy, cz = xi + dx, yi + dy, zi + dz
                px = cx + 0.5 + (hash01(cx, cy, cz, seed) - 0.5) * jitter
                py = cy + 0.5 + (hash01(cx, cy, cz, seed + 7) - 0.5) * jitter
                pz = cz + 0.5 + (hash01(cx, cy, cz, seed + 19) - 0.5) * jitter
                d = np.sqrt((px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2)
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                f1 = np.where(closer, d, f1)
    return f1, f2


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def smax(a, b, k):
    """Smooth maximum (polynomial), k = blend width in field units."""
    h = np.clip(0.5 + 0.5 * (a - b) / k, 0.0, 1.0)
    return a * h + b * (1 - h) + k * h * (1 - h) * 0.5 * 0 + (k * h * (1 - h)) * 0.0


def bilinear(grid, u, v):
    """Sample a 2D array at fractional index coordinates (u along axis 0, v along axis 1), clamped."""
    nu, nv = grid.shape
    u = np.clip(u, 0, nu - 1.001)
    v = np.clip(v, 0, nv - 1.001)
    i, j = np.floor(u).astype(np.int64), np.floor(v).astype(np.int64)
    fu, fv = u - i, v - j
    return (grid[i, j] * (1 - fu) * (1 - fv) + grid[i + 1, j] * fu * (1 - fv) + grid[i, j + 1] * (1 - fu) * fv + grid[i + 1, j + 1] * fu * fv)
