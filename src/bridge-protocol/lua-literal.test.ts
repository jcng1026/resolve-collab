import { describe, expect, it } from "vitest";
import { LuaSerializeError, toLuaLiteral } from "./lua-literal.ts";

describe("toLuaLiteral", () => {
  it("serialises scalars", () => {
    expect(toLuaLiteral("hi")).toBe('"hi"');
    expect(toLuaLiteral(42)).toBe("42");
    expect(toLuaLiteral(-1.5)).toBe("-1.5");
    expect(toLuaLiteral(-0)).toBe("0");
    expect(toLuaLiteral(true)).toBe("true");
    expect(toLuaLiteral(false)).toBe("false");
  });

  it("serialises arrays as sequence tables", () => {
    expect(toLuaLiteral([1, "a", false])).toBe('{1,"a",false}');
    expect(toLuaLiteral([])).toBe("{}");
  });

  it("always brackets object keys so no identifiers are emitted", () => {
    expect(toLuaLiteral({ cmd: "ping", args: { n: 1 } })).toBe(
      '{["cmd"]="ping",["args"]={["n"]=1}}',
    );
  });

  it("escapes quotes, backslashes and control characters", () => {
    expect(toLuaLiteral('a"b\\c\nd')).toBe('"a\\"b\\\\c\\010d"');
    expect(toLuaLiteral("\u0000")).toBe('"\\000"');
  });

  it("writes non-ASCII text as UTF-8 byte escapes", () => {
    // "é" is 0xC3 0xA9 in UTF-8.
    expect(toLuaLiteral("é")).toBe('"\\195\\169"');
  });

  it("neutralises strings that look like Lua code", () => {
    const literal = toLuaLiteral({ name: '"]=os.execute("calc")--' });
    expect(literal).toBe('{["name"]="\\"]=os.execute(\\"calc\\")--"}');
  });

  it("rejects values Lua tables cannot hold faithfully", () => {
    expect(() => toLuaLiteral(Number.NaN)).toThrow(LuaSerializeError);
    expect(() => toLuaLiteral(Number.POSITIVE_INFINITY)).toThrow(LuaSerializeError);
    expect(() => toLuaLiteral(null as never)).toThrow(LuaSerializeError);
    expect(() => toLuaLiteral(undefined as never)).toThrow(LuaSerializeError);
    expect(() => toLuaLiteral((() => 1) as never)).toThrow(LuaSerializeError);
  });

  it("rejects circular and overly deep structures", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => toLuaLiteral(loop as never)).toThrow(/circular/);

    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => toLuaLiteral(deep as never)).toThrow(/nesting/);
  });

  it("allows the same object to appear twice when it is not a cycle", () => {
    const shared = { a: 1 };
    expect(toLuaLiteral([shared, shared])).toBe('{{["a"]=1},{["a"]=1}}');
  });
});
