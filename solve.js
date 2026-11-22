// Fast drop-in for csv-reader 1.0.0: same answers, slice-based single pass.
// run(input) returns {columns, rows, errors} for input {text, header}.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  let fValue = '';
  let fEnded = 2;
  let fAdded = 0;

  // Cached first CR / LF at or after the last query point (Infinity: none left).
  // Query points never move backwards, so a cached hit stays the first one ahead.
  let nextCR = -2;
  let nextLF = -2;
  function crFrom(p) {
    if (nextCR < p) {
      const x = text.indexOf('\r', p);
      nextCR = x === -1 ? Infinity : x;
    }
    return nextCR;
  }
  function lfFrom(p) {
    if (nextLF < p) {
      const x = text.indexOf('\n', p);
      nextLF = x === -1 ? Infinity : x;
    }
    return nextLF;
  }

  function readUnquoted(prefix) {
    let start = pos;
    let parts = null;
    let added = 0;
    while (true) {
      const iComma = text.indexOf(',', start);
      const lf = lfFrom(start);
      const iLF = lf === Infinity ? -1 : lf;
      let bound;
      let ended;
      if (iComma === -1 && iLF === -1) { bound = len; ended = 2; }
      else if (iLF === -1 || (iComma !== -1 && iComma < iLF)) { bound = iComma; ended = 0; }
      else { bound = iLF; ended = 1; }

      const cr = crFrom(start);
      if (cr < bound) {
        if (ended === 1 && cr === bound - 1) {
          const seg = text.slice(start, cr);
          added += cr - start;
          fValue = parts ? prefix + parts.join('') + seg : (prefix === '' ? seg : prefix + seg);
          fAdded = added;
          pos = bound + 1;
          line += 1;
          fEnded = 1;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(start, cr));
        added += cr - start;
        start = cr + 1;
        continue;
      }
      const seg = text.slice(start, bound);
      added += bound - start;
      fValue = parts ? prefix + parts.join('') + seg : (prefix === '' ? seg : prefix + seg);
      fAdded = added;
      if (ended === 0) pos = bound + 1;
      else if (ended === 1) { pos = bound + 1; line += 1; }
      else pos = len;
      fEnded = ended;
      return;
    }
  }

  // After a closing quote at pos-1: delimiter, line break, end, or junk.
  function afterQuote(value) {
    if (pos >= len) { fValue = value; fEnded = 2; return; }
    const nc = text.charCodeAt(pos);
    if (nc === 44) { pos += 1; fValue = value; fEnded = 0; return; }
    if (nc === 10) { pos += 1; line += 1; fValue = value; fEnded = 1; return; }
    if (nc === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1; fValue = value; fEnded = 1; return;
    }
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    const contentStart = pos + 1;

    // Fast path: a closing quote with no doubled quote and no CR/LF before it.
    const q = text.indexOf('"', contentStart);
    if (q === -1) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    if (text.charCodeAt(q + 1) !== 34 && crFrom(contentStart) >= q && lfFrom(contentStart) >= q) {
      const value = text.slice(contentStart, q);
      pos = q + 1;
      afterQuote(value);
      return;
    }

    // General path: doubled quotes, CR/LF inside, or a later closing quote.
    let segStart = contentStart;
    let parts = null;
    let i = contentStart;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        if (i + 1 < len && text.charCodeAt(i + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, i), '"');
          i += 2;
          segStart = i;
          continue;
        }
        let value;
        if (parts !== null) {
          parts.push(text.slice(segStart, i));
          value = parts.join('');
        } else {
          value = text.slice(contentStart, i);
        }
        pos = i + 1;
        afterQuote(value);
        return;
      }
      if (c === 13) {
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, i), '\n');
        line += 1;
        i += (i + 1 < len && text.charCodeAt(i + 1) === 10) ? 2 : 1;
        segStart = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    pos = open + 1;
    line = openLine;
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    readUnquoted('"');
  }

  while (true) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      if (quoted) readQuoted(); else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === 0);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.slice(width);
      fields.length = width;
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
