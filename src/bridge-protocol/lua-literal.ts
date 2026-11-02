// Serialises plain data into a Lua 5.1 table literal for bridge request files.
//
// The bridge loads request files with `loadfile` in an empty environment
// (SPEC §3.2), so the output must be pure data: table constructors, strings,
// numbers and booleans only. No identifiers are ever emitted (keys are always
// bracketed strings), which means a request file cannot reference a global or
// call a function even if its contents came from a peer.

export type LuaValue =
  | string
  | number
  | boolean
  | readonly LuaValue[]
  | { readonly [key: string]: LuaValue };

export class LuaSerializeError extends Error {
  override name = "LuaSerializeError";
}

const MAX_DEPTH = 32;

export function toLuaLiteral(value: LuaValue): string {
  return serialize(value, 0, new Set());
}

function serialize(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > MAX_DEPTH) {
    throw new LuaSerializeError(`nesting deeper than ${MAX_DEPTH}`);
  }
  switch (typeof value) {
    case "string":
      return quote(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new LuaSerializeError(`non-finite number: ${value}`);
      }
      // Lua 5.1 has no -0 literal distinction worth preserving; normalise it.
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (value === null) {
        throw new LuaSerializeError("null is not representable (Lua tables drop nil)");
      }
      if (seen.has(value)) {
        throw new LuaSerializeError("circular reference");
      }
      seen.add(value);
      const body = Array.isArray(value)
        ? value.map((item) => serialize(item, depth + 1, seen))
        : Object.entries(value).map(
            ([key, item]) => `[${quote(key)}]=${serialize(item, depth + 1, seen)}`,
          );
      seen.delete(value);
      return `{${body.join(",")}}`;
    }
    default:
      throw new LuaSerializeError(`unsupported type: ${typeof value}`);
  }
}

// Lua 5.1 strings are byte strings. Everything outside printable ASCII is
// written as a decimal escape (\ddd) so the file content is plain ASCII and
// the bytes the bridge sees are exactly the UTF-8 bytes of the input.
function quote(text: string): string {
  let out = '"';
  for (const byte of Buffer.from(text, "utf8")) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\${byte.toString().padStart(3, "0")}`;
  }
  return `${out}"`;
}
