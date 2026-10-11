import { deflateSync } from 'node:zlib';

/**
 * A tiny PNG encoder. Only used by simulate mode (so the phone's screen peek
 * still shows something on a machine with no display), which is why it can get
 * away with being this small. Real captures come from the OS.
 */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
};

export interface RgbaImage {
  width: number;
  height: number;
  /** Raw RGBA bytes, width * height * 4. */
  pixels: Uint8Array;
}

export const encodePng = (image: RgbaImage): Buffer => {
  const { width, height, pixels } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
};

export const createImage = (width: number, height: number, fill: [number, number, number, number]): RgbaImage => {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = fill[0];
    pixels[i * 4 + 1] = fill[1];
    pixels[i * 4 + 2] = fill[2];
    pixels[i * 4 + 3] = fill[3];
  }
  return { width, height, pixels };
};

export const fillRect = (
  image: RgbaImage,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: [number, number, number, number],
  radius = 0
): void => {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + width));
  const y1 = Math.min(image.height, Math.ceil(y + height));

  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      if (radius > 0) {
        const dx = Math.max(x0 + radius - px, 0, px - (x1 - radius - 1));
        const dy = Math.max(y0 + radius - py, 0, py - (y1 - radius - 1));
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      const offset = (py * image.width + px) * 4;
      image.pixels[offset] = colour[0];
      image.pixels[offset + 1] = colour[1];
      image.pixels[offset + 2] = colour[2];
      image.pixels[offset + 3] = colour[3];
    }
  }
};

export const strokeCircle = (
  image: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  colour: [number, number, number, number],
  thickness = 2
): void => {
  for (let angle = 0; angle < Math.PI * 2; angle += 0.008) {
    for (let t = 0; t < thickness; t += 1) {
      const px = Math.round(cx + Math.cos(angle) * (radius + t));
      const py = Math.round(cy + Math.sin(angle) * (radius + t));
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const offset = (py * image.width + px) * 4;
      image.pixels[offset] = colour[0];
      image.pixels[offset + 1] = colour[1];
      image.pixels[offset + 2] = colour[2];
      image.pixels[offset + 3] = colour[3];
    }
  }
};
