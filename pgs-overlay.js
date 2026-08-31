
'use strict';

class PgsRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.displaySets = [];
    this.activeIndex = -1;
  }

  async load(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`sup fetch failed: ${response.status}`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    this.displaySets = PgsRenderer.parseSup(buffer);
    this.activeIndex = -1;
    return this.displaySets.length;
  }

  clear() {
    this.displaySets = [];
    this.activeIndex = -1;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  renderAt(mediaTimeSeconds) {
    const timeMs = mediaTimeSeconds * 1000;
    let index = -1;
    for (let i = 0; i < this.displaySets.length; i++) {
      if (this.displaySets[i].timeMs <= timeMs) {
        index = i;
      } else {
        break;
      }
    }
    if (index === this.activeIndex) {
      return;
    }
    this.activeIndex = index;
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (index < 0) {
      return;
    }
    const set = this.displaySets[index];
    if (set.width && (this.canvas.width !== set.width || this.canvas.height !== set.height)) {
      this.canvas.width = set.width;
      this.canvas.height = set.height;
    }
    for (const object of set.objects) {
      ctx.putImageData(object.imageData, object.x, object.y);
    }
  }

  static parseSup(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const palettes = new Map();
    const objects = new Map();
    const displaySets = [];
    let composition = null;
    let offset = 0;

    while (offset + 13 <= data.length) {
      if (data[offset] !== 0x50 || data[offset + 1] !== 0x47) {
        offset += 1;
        continue;
      }
      const ptsMs = view.getUint32(offset + 2) / 90;
      const type = data[offset + 10];
      const size = view.getUint16(offset + 11);
      const payloadStart = offset + 13;
      if (payloadStart + size > data.length) {
        break;
      }
      const payload = data.subarray(payloadStart, payloadStart + size);

      switch (type) {
        case 0x14:
          PgsRenderer.parsePalette(payload, palettes);
          break;
        case 0x15:
          PgsRenderer.parseObject(payload, view, payloadStart, objects);
          break;
        case 0x16:
          composition = PgsRenderer.parseComposition(payload, ptsMs);
          break;
        case 0x17:
          if (composition) {
            PgsRenderer.parseWindows(payload, composition);
          }
          break;
        case 0x80:
          if (composition) {
            displaySets.push(
              PgsRenderer.buildDisplaySet(composition, palettes, objects),
            );
            composition = null;
          }
          break;
        default:
          break;
      }
      offset = payloadStart + size;
    }
    return displaySets;
  }

  static parsePalette(payload, palettes) {
    const paletteID = payload[0];
    const entries = palettes.get(paletteID) || new Uint8ClampedArray(256 * 4);
    for (let i = 2; i + 5 <= payload.length; i += 5) {
      const id = payload[i];
      const y = payload[i + 1];
      const cr = payload[i + 2] - 128;
      const cb = payload[i + 3] - 128;
      const alpha = payload[i + 4];
      const r = y + 1.5748 * cr;
      const g = y - 0.1873 * cb - 0.4681 * cr;
      const b = y + 1.8556 * cb;
      entries[id * 4] = r;
      entries[id * 4 + 1] = g;
      entries[id * 4 + 2] = b;
      entries[id * 4 + 3] = alpha;
    }
    palettes.set(paletteID, entries);
  }

  static parseObject(payload, view, payloadStart, objects) {
    const objectID = (payload[0] << 8) | payload[1];
    const lastInSequence = (payload[3] & 0x40) !== 0;
    const firstInSequence = (payload[3] & 0x80) !== 0;
    if (firstInSequence) {
      const width = (payload[7] << 8) | payload[8];
      const height = (payload[9] << 8) | payload[10];
      objects.set(objectID, {
        width,
        height,
        rle: [payload.subarray(11)],
        complete: lastInSequence,
      });
    } else {
      const entry = objects.get(objectID);
      if (entry) {
        entry.rle.push(payload.subarray(4));
        entry.complete = entry.complete || lastInSequence;
      }
    }
  }

  static parseComposition(payload, ptsMs) {
    const width = (payload[0] << 8) | payload[1];
    const height = (payload[2] << 8) | payload[3];
    const paletteID = payload[9];
    const objectCount = payload[10];
    const objects = [];
    let cursor = 11;
    for (let i = 0; i < objectCount && cursor + 8 <= payload.length; i++) {
      const objectID = (payload[cursor] << 8) | payload[cursor + 1];
      const cropped = (payload[cursor + 3] & 0x80) !== 0;
      const x = (payload[cursor + 4] << 8) | payload[cursor + 5];
      const y = (payload[cursor + 6] << 8) | payload[cursor + 7];
      objects.push({ objectID, x, y });
      cursor += cropped ? 16 : 8;
    }
    return { timeMs: ptsMs, width, height, paletteID, objectRefs: objects, windows: [] };
  }

  static parseWindows(payload, composition) {
    const count = payload[0];
    let cursor = 1;
    for (let i = 0; i < count && cursor + 9 <= payload.length; i++) {
      composition.windows.push({
        x: (payload[cursor + 1] << 8) | payload[cursor + 2],
        y: (payload[cursor + 3] << 8) | payload[cursor + 4],
        width: (payload[cursor + 5] << 8) | payload[cursor + 6],
        height: (payload[cursor + 7] << 8) | payload[cursor + 8],
      });
      cursor += 9;
    }
  }

  static buildDisplaySet(composition, palettes, objects) {
    const palette = palettes.get(composition.paletteID);
    const rendered = [];
    for (const ref of composition.objectRefs) {
      const source = objects.get(ref.objectID);
      if (!source || !palette) {
        continue;
      }
      const imageData = PgsRenderer.decodeRLE(source, palette);
      if (imageData) {
        rendered.push({ imageData, x: ref.x, y: ref.y });
      }
    }
    return {
      timeMs: composition.timeMs,
      width: composition.width,
      height: composition.height,
      objects: rendered,
    };
  }

  static decodeRLE(source, palette) {
    const { width, height } = source;
    if (!width || !height) {
      return null;
    }
    const rle = PgsRenderer.concat(source.rle);
    const pixels = new Uint8ClampedArray(width * height * 4);
    let x = 0;
    let y = 0;
    let i = 0;

    const put = (color, count) => {
      const base = palette.subarray(color * 4, color * 4 + 4);
      for (let n = 0; n < count && y < height; n++) {
        const offset = (y * width + x) * 4;
        pixels[offset] = base[0];
        pixels[offset + 1] = base[1];
        pixels[offset + 2] = base[2];
        pixels[offset + 3] = base[3];
        x += 1;
      }
    };

    while (i < rle.length && y < height) {
      const first = rle[i++];
      if (first !== 0) {
        put(first, 1);
        continue;
      }
      const flags = rle[i++];
      if (flags === 0) {
        x = 0;
        y += 1;
      } else if ((flags & 0xc0) === 0) {
        put(0, flags & 0x3f);
      } else if ((flags & 0xc0) === 0x40) {
        put(0, ((flags & 0x3f) << 8) | rle[i++]);
      } else if ((flags & 0xc0) === 0x80) {
        put(rle[i++], flags & 0x3f);
      } else {
        const count = ((flags & 0x3f) << 8) | rle[i++];
        put(rle[i++], count);
      }
    }
    return new ImageData(pixels, width, height);
  }

  static concat(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      joined.set(chunk, cursor);
      cursor += chunk.length;
    }
    return joined;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { PgsRenderer };
}
