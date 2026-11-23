// A small protobuf (proto2) reader driven by a schema table (core/lri-schema.js: messages[name][field number] = [name, kind, repeated, packed]).
// Used for the messages in Light L16 .lri files. Only reading is needed. Field names stay as the definitions write them (snake_case); enums become their names;
// 64 bit integers become numbers (exact up to 2^53, which file offsets and times stay far below); repeated fields are arrays (packed floats a Float32Array).

const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_LEN = 2;
const WIRE_32 = 5;

const TWO32 = 4294967296;

// Reads a varint at `pos`, returns [hi, lo, next] (an unsigned 64 bit value as two 32 bit halves).
function varint(buf, pos) {
  let lo = 0;
  let hi = 0;
  let shift = 0;
  for (let n = 0; n < 10; n++) {
    const b = buf[pos++];
    if (b === undefined) throw new Error('protobuf: message ends inside a number');
    if (shift < 28) lo |= (b & 0x7f) << shift;
    else if (shift === 28) {
      lo |= (b & 0x0f) << 28;
      hi = (b & 0x7f) >> 4;
    } else hi |= (b & 0x7f) << (shift - 32);
    shift += 7;
    if (!(b & 0x80)) return [hi >>> 0, lo >>> 0, pos];
  }
  throw new Error('protobuf: number is longer than 10 bytes');
}

function toNumber(hi, lo, kind) {
  switch (kind) {
    case 'int32':
      return lo | 0;
    case 'uint32':
      return lo >>> 0;
    case 'sint32':
      return ((lo >>> 1) ^ -(lo & 1)) | 0;
    case 'bool':
      return !!(lo || hi);
    case 'uint64':
      return hi * TWO32 + lo;
    case 'int64': {
      if (hi & 0x80000000) {
        // two's complement: -(2^64 - value)
        const nlo = (~lo + 1) >>> 0;
        const nhi = (~hi + (nlo === 0 ? 1 : 0)) >>> 0;
        return -(nhi * TWO32 + nlo);
      }
      return hi * TWO32 + lo;
    }
    case 'sint64': {
      const sign = lo & 1;
      const rlo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
      const rhi = hi >>> 1;
      const v = rhi * TWO32 + rlo;
      return sign ? -v - 1 : v;
    }
    default:
      return hi * TWO32 + lo;
  }
}

const VARINT_KINDS = new Set(['int32', 'uint32', 'sint32', 'int64', 'uint64', 'sint64', 'bool']);
const decoder = new TextDecoder();

// Decodes the message `name` from buf[start, end). `schema` is LRI_SCHEMA.
export function decodeMessage(schema, name, buf, start = 0, end = buf.length) {
  const fields = schema.messages[name];
  if (!fields) throw new Error(`protobuf: unknown message ${name}`);
  const out = {};
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  const put = (f, value) => {
    const key = f[0];
    if (f[2]) (out[key] || (out[key] = [])).push(value);
    else out[key] = value;
  };
  while (pos < end) {
    let tag;
    [, tag, pos] = varint(buf, pos);
    const num = tag >>> 3;
    const wire = tag & 7;
    const f = fields[num];
    let value;
    if (wire === WIRE_VARINT) {
      let hi;
      let lo;
      [hi, lo, pos] = varint(buf, pos);
      if (!f) continue;
      const kind = f[1];
      if (kind[0] === 'e') value = schema.enums[kind.slice(2)][lo | 0] ?? lo | 0;
      else value = toNumber(hi, lo, kind);
      put(f, value);
    } else if (wire === WIRE_64) {
      if (f) {
        value = f[1] === 'double' ? view.getFloat64(pos, true) : view.getUint32(pos + 4, true) * TWO32 + view.getUint32(pos, true);
        put(f, value);
      }
      pos += 8;
    } else if (wire === WIRE_32) {
      if (f) {
        const k = f[1];
        value = k === 'float' ? view.getFloat32(pos, true) : k === 'sfixed32' ? view.getInt32(pos, true) : view.getUint32(pos, true);
        put(f, value);
      }
      pos += 4;
    } else if (wire === WIRE_LEN) {
      let len;
      [, len, pos] = varint(buf, pos);
      const stop = pos + len;
      if (stop > end) throw new Error('protobuf: a field runs past the end of its message');
      if (f) {
        const kind = f[1];
        if (kind === 'string') put(f, decoder.decode(buf.subarray(pos, stop)));
        else if (kind === 'bytes') put(f, buf.slice(pos, stop));
        else if (kind[0] === 'm') put(f, decodeMessage(schema, kind.slice(2), buf, pos, stop));
        else if (kind === 'float') {
          // packed floats
          const n = len >> 2;
          const arr = new Float32Array(n);
          for (let k = 0; k < n; k++) arr[k] = view.getFloat32(pos + 4 * k, true);
          const prev = out[f[0]];
          out[f[0]] = prev && prev.length ? Float32Array.from([...prev, ...arr]) : arr;
        } else if (kind === 'double') {
          const n = len >> 3;
          const arr = new Float64Array(n);
          for (let k = 0; k < n; k++) arr[k] = view.getFloat64(pos + 8 * k, true);
          out[f[0]] = arr;
        } else if (VARINT_KINDS.has(kind) || kind[0] === 'e') {
          // packed varints
          const list = out[f[0]] || (out[f[0]] = []);
          let p = pos;
          while (p < stop) {
            let hi;
            let lo;
            [hi, lo, p] = varint(buf, p);
            list.push(kind[0] === 'e' ? schema.enums[kind.slice(2)][lo | 0] ?? lo | 0 : toNumber(hi, lo, kind));
          }
        }
      }
      pos = stop;
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
  }
  return out;
}

// Merges message `src` into `dst` the way protobuf's MergeFrom does: single values are replaced, repeated ones appended, messages merged field by field.
export function mergeMessage(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    const cur = dst[k];
    if (Array.isArray(v)) dst[k] = cur ? cur.concat(v) : v;
    else if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && cur && typeof cur === 'object' && !Array.isArray(cur) && !ArrayBuffer.isView(cur)) mergeMessage(cur, v);
    else dst[k] = v;
  }
  return dst;
}
