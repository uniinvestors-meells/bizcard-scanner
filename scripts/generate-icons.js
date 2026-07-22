// Hand-rolled PNG encoder (zlib + CRC only, no image libraries) that draws a
// simple business-card glyph on an indigo background, at 192px and 512px.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const INDIGO = [0x4f, 0x46, 0xe5];
const WHITE = [0xff, 0xff, 0xff];
const LINE = [0xc7, 0xc2, 0xf9];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function drawCardGlyph(size) {
  // pixel grid, each entry [r,g,b]
  const px = Array.from({ length: size }, () => Array.from({ length: size }, () => INDIGO));

  const cardLeft = Math.round(size * 0.2);
  const cardRight = Math.round(size * 0.8);
  const cardTop = Math.round(size * 0.32);
  const cardBottom = Math.round(size * 0.68);

  for (let y = cardTop; y < cardBottom; y++) {
    for (let x = cardLeft; x < cardRight; x++) {
      px[y][x] = WHITE;
    }
  }

  // a couple of "text lines" on the card
  const lineHeight = Math.max(2, Math.round(size * 0.02));
  const line1Y = cardTop + Math.round((cardBottom - cardTop) * 0.35);
  const line2Y = cardTop + Math.round((cardBottom - cardTop) * 0.6);
  const lineLeft = cardLeft + Math.round(size * 0.06);
  const line1Right = cardLeft + Math.round((cardRight - cardLeft) * 0.6);
  const line2Right = cardLeft + Math.round((cardRight - cardLeft) * 0.4);

  for (let y = line1Y; y < line1Y + lineHeight; y++) {
    for (let x = lineLeft; x < line1Right; x++) px[y][x] = LINE;
  }
  for (let y = line2Y; y < line2Y + lineHeight; y++) {
    for (let x = lineLeft; x < line2Right; x++) px[y][x] = LINE;
  }

  return px;
}

function encodePng(size) {
  const px = drawCardGlyph(size);
  const rowBytes = size * 3 + 1;
  const raw = Buffer.alloc(rowBytes * size);

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px[y][x];
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const png = encodePng(size);
  const path = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(path, png);
  console.log(`wrote icon-${size}.png (${png.length} bytes)`);
}
