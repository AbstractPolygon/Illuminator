#!/usr/bin/env node
// Turns the Light L16 message definitions (.proto files, proto2) into app/js/core/lri-schema.js, the table the small reader in core/protobuf.js decodes with.
//   node scripts/proto-to-schema.mjs PROTO_DIR   (a folder of the L16 message definitions)
// Only the messages a .lri file carries are kept (google_protobuf_descriptor.proto is skipped). Re-run it when the definitions change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/proto-to-schema.mjs PROTO_DIR');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tokens = [];
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.proto') && n !== 'google_protobuf_descriptor.proto').sort()) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const t = text.match(/"[^"]*"|[A-Za-z_][\w.]*|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|[{}=;\[\],<>]/gi) || [];
  tokens.push({ file: f, t });
}

const messages = {};
const enums = {};
const pending = [];

function parseFile({ file, t }) {
  let i = 0;
  const next = () => t[i++];
  const peek = () => t[i];
  const skipStatement = () => {
    while (i < t.length && t[i] !== ';') i++;
    i++;
  };
  function parseEnum(scope) {
    const name = next();
    const full = `${scope}${name}`;
    enums[full] = {};
    next(); // {
    while (peek() !== '}') {
      if (peek() === 'option' || peek() === 'reserved') {
        skipStatement();
        continue;
      }
      const key = next();
      next(); // =
      enums[full][+next()] = key;
      skipStatement();
    }
    next(); // }
  }
  function parseMessage(scope) {
    const name = next();
    const full = `${scope}${name}`;
    const msg = (messages[full] = { fields: {} });
    next(); // {
    while (peek() !== '}') {
      const w = peek();
      if (w === 'message') {
        next();
        parseMessage(`${full}.`);
      } else if (w === 'enum') {
        next();
        parseEnum(`${full}.`);
      } else if (w === 'option' || w === 'reserved' || w === 'extensions') {
        skipStatement();
      } else if (w === 'oneof' || w === 'map' || w === 'group') {
        throw new Error(`${file}: ${w} is not supported`);
      } else {
        const label = next(); // required | optional | repeated
        const type = next();
        const fname = next();
        next(); // =
        const num = +next();
        let packed = 0;
        if (peek() === '[') {
          while (peek() !== ']') {
            const tok = next();
            if (tok === 'packed') {
              next();
              packed = next() === 'true' ? 1 : 0;
            }
          }
          next();
        }
        next(); // ;
        msg.fields[num] = { name: fname, type, repeated: label === 'repeated' ? 1 : 0, packed };
        pending.push({ full, num });
      }
    }
    next(); // }
  }
  while (i < t.length) {
    const w = next();
    if (w === 'syntax' || w === 'package' || w === 'import' || w === 'option') skipStatement();
    else if (w === 'message') parseMessage('');
    else if (w === 'enum') parseEnum('');
    else throw new Error(`${file}: unexpected ${w}`);
  }
}
tokens.forEach(parseFile);

const SCALARS = new Set(['int32', 'uint32', 'sint32', 'int64', 'uint64', 'sint64', 'bool', 'float', 'double', 'string', 'bytes', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64']);
function resolve(scopeFull, type) {
  if (SCALARS.has(type)) return type;
  // search the enclosing scopes, innermost first
  const parts = scopeFull.split('.');
  for (let n = parts.length; n >= 0; n--) {
    const cand = [...parts.slice(0, n), type].join('.');
    if (messages[cand]) return `m:${cand}`;
    if (enums[cand]) return `e:${cand}`;
  }
  throw new Error(`cannot resolve ${type} in ${scopeFull}`);
}
const out = { messages: {}, enums };
for (const [full, m] of Object.entries(messages)) {
  out.messages[full] = {};
  for (const [num, f] of Object.entries(m.fields)) out.messages[full][num] = [f.name, resolve(full, f.type), f.repeated, f.packed];
}
const body = JSON.stringify(out);
fs.writeFileSync(
  path.join(root, 'app/js/core/lri-schema.js'),
  `// The Light L16 .lri message definitions as a table, made by scripts/proto-to-schema.mjs (do not edit by hand).\n// messages[name][field number] = [name, kind, repeated, packed]; kind is a scalar type, "m:Message" or "e:Enum". enums[name][value] = name.\nexport const LRI_SCHEMA = ${body};\n`,
);
console.log(`${Object.keys(out.messages).length} messages, ${Object.keys(out.enums).length} enums`);
