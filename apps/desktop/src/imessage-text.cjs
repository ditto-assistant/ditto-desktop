const { TextDecoder } = require("node:util");

// Read only the leading NSAttributedString -> NSString text payload. Do not
// instantiate archived classes or guess text from printable attribute metadata.
function archivedText(hex) {
  if (!hex || hex.length % 2 || hex.length > 2 * 1024 * 1024 || !/^[\da-f]+$/i.test(hex))
    return null;
  const data = Buffer.from(hex, "hex");
  let offset = 0;
  let littleEndian = true;
  const strings = [];
  const references = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const take = (length) => {
    if (!Number.isInteger(length) || length < 0 || offset + length > data.length)
      throw new Error("Truncated iMessage archive");
    const value = data.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const byte = () => take(1).readInt8();
  const integer = (head = byte(), signed = true) => {
    if (head === -127 || head === -126) {
      const size = head === -127 ? 2 : 4;
      const value = take(size);
      return signed
        ? littleEndian
          ? value.readIntLE(0, size)
          : value.readIntBE(0, size)
        : littleEndian
          ? value.readUIntLE(0, size)
          : value.readUIntBE(0, size);
    }
    if (head >= -128 && head <= -111) throw new Error("Invalid archive integer");
    return signed ? head : head & 255;
  };
  const sharedString = () => {
    const head = byte();
    if (head === -124) {
      const value = utf8.decode(take(integer(byte(), false)));
      strings.push(value);
      return value;
    }
    const value = strings[integer(head) + 110];
    if (typeof value !== "string") throw new Error("Invalid archive string reference");
    return value;
  };
  const classes = (depth = 0) => {
    if (depth > 8) throw new Error("Unsupported archive class hierarchy");
    const head = byte();
    if (head === -123) return [];
    if (head !== -124) {
      const value = references[integer(head) + 110];
      if (!Array.isArray(value)) throw new Error("Invalid archive class reference");
      return value;
    }
    const name = sharedString();
    const version = integer();
    const index = references.push(null) - 1;
    const value = [{ name, version }, ...classes(depth + 1)];
    references[index] = value;
    return value;
  };
  const object = () => {
    if (byte() !== -124) throw new Error("Expected archive object");
    references.push(null);
    return classes();
  };
  try {
    if (byte() !== 4 || byte() !== 11) return null;
    const signature = take(11).toString("ascii");
    if (!["streamtyped", "typedstream"].includes(signature)) return null;
    littleEndian = signature === "streamtyped";
    integer(); // NSArchiver system version.
    if (sharedString() !== "@") return null;
    const outer = object();
    if (!outer.some(({ name, version }) => name === "NSAttributedString" && version === 0))
      return null;
    if (sharedString() !== "@") return null;
    const inner = object();
    if (!inner.some(({ name, version }) => name === "NSString" && version === 1)) return null;
    if (sharedString() !== "+") return null;
    const text = utf8.decode(take(integer(byte(), false)));
    if (byte() !== -122) return null; // NSString terminator, before attributed metadata.
    return text;
  } catch {
    return null;
  }
}

function imessageText(text, attributedBody) {
  const body = text || archivedText(attributedBody);
  return body?.replaceAll("\uFFFC", "[Attachment]") || "[Message content unavailable]";
}

module.exports = { imessageText };
