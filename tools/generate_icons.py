"""Generate extension icons using only the Python standard library."""
from pathlib import Path
import math
import struct
import zlib

root = Path(__file__).resolve().parents[1] / 'icons'
root.mkdir(exist_ok=True)
def segment_distance(x, y, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    t = max(0, min(1, ((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)
def color(x, y):
    radius = 27
    cx, cy = max(radius, min(128-radius, x)), max(radius, min(128-radius, y))
    if math.hypot(x-cx, y-cy) > radius:
        return 255, 255, 255, 0
    if min(segment_distance(x,y,(32,65),(54,85)), segment_distance(x,y,(54,85),(97,42))) <= 6:
        return 255, 255, 255, 255
    return 41, 79, 199, 255
for size in (16, 48, 128):
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            samples = [color((x+(sx+.5)/4)*128/size, (y+(sy+.5)/4)*128/size) for sy in range(4) for sx in range(4)]
            pixels.extend(round(sum(c[i] for c in samples)/16) for i in range(4))
    def chunk(name, data):
        return struct.pack('!I',len(data))+name+data+struct.pack('!I',zlib.crc32(name+data)&0xffffffff)
    data = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(pixels)))+chunk(b'IEND',b'')
    (root/f'{size}.png').write_bytes(data)
