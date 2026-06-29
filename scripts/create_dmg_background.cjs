#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const width = 660;
const height = 420;
const output = path.join(__dirname, '..', 'build', 'dmg-background.png');
const pixels = Buffer.alloc(width * height * 4);

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  const alpha = a / 255;
  const inverse = 1 - alpha;
  pixels[i] = clamp(r * alpha + pixels[i] * inverse);
  pixels[i + 1] = clamp(g * alpha + pixels[i + 1] * inverse);
  pixels[i + 2] = clamp(b * alpha + pixels[i + 2] * inverse);
  pixels[i + 3] = 255;
}

function fillBackground() {
  for (let y = 0; y < height; y += 1) {
    const t = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const radial = Math.max(0, 1 - Math.hypot(x - 500, y - 120) / 520);
      const r = 248 - t * 9 + radial * 5;
      const g = 251 - t * 11 + radial * 4;
      const b = 255 - t * 13 + radial * 8;
      setPixel(x, y, r, g, b, 255);
    }
  }
}

function roundedRect(x, y, w, h, radius, color, alpha = 255) {
  const [r, g, b] = color;
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const cx = Math.min(Math.max(xx, x + radius), x + w - radius - 1);
      const cy = Math.min(Math.max(yy, y + radius), y + h - radius - 1);
      if (Math.hypot(xx - cx, yy - cy) > radius) continue;
      setPixel(xx, yy, r, g, b, alpha);
    }
  }
}

function filledCircle(cx, cy, radius, color, alpha = 255) {
  const [r, g, b] = color;
  const minX = Math.floor(cx - radius);
  const maxX = Math.ceil(cx + radius);
  const minY = Math.floor(cy - radius);
  const maxY = Math.ceil(cy + radius);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (distance > radius + 0.5) continue;
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      setPixel(x, y, r, g, b, alpha * coverage);
    }
  }
}

function line(x1, y1, x2, y2, width, color, alpha = 255) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    filledCircle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color, alpha);
  }
}

function card(x, y, w, h) {
  roundedRect(x + 2, y + 6, w, h, 22, [36, 74, 120], 16);
  roundedRect(x + 1, y + 3, w, h, 22, [36, 74, 120], 10);
  roundedRect(x, y, w, h, 22, [255, 255, 255], 215);
}

function drawArrow() {
  const y = 214;
  const blue = [0, 122, 255];
  const lightBlue = [95, 174, 255];
  line(270, y + 18, 364, y + 18, 4, [0, 70, 180], 28);
  line(272, y, 375, y, 10, blue, 238);
  line(348, y - 27, 382, y, 10, blue, 238);
  line(348, y + 27, 382, y, 10, blue, 238);
  line(276, y - 5, 356, y - 5, 2.5, lightBlue, 120);
  filledCircle(272, y, 5, blue, 238);
  filledCircle(382, y, 5, blue, 238);
}

function decorativeGlints() {
  roundedRect(36, 34, 112, 8, 4, [0, 122, 255], 32);
  roundedRect(48, 54, 74, 6, 3, [52, 199, 89], 26);
  roundedRect(510, 346, 94, 8, 4, [0, 122, 255], 24);
  roundedRect(536, 366, 54, 6, 3, [52, 199, 89], 24);
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function writePng() {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, png);
  console.log(`created ${output}`);
}

fillBackground();
decorativeGlints();
card(100, 136, 156, 156);
card(410, 136, 156, 156);
drawArrow();
writePng();
