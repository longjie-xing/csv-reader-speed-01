// A fast drop-in for csv-reader 1.0.0: readCsv's exact answers, much faster.
//
// The reader walks the text once, left to right, with the reference's own
// broken-row policy: a U+FEFF at the very start is dropped; a record ends at
// LF or CRLF and a line left with no characters is no record; outside quotes
// a CR not followed by LF is dropped (stray_cr); a field that opens with a
// quote runs to the next quote that is not doubled, "" inside it one quote
// and each CRLF or lone CR inside it read as LF; what follows its closing
// quote, up to the next comma or line break, is appended as it stands
// (quote_junk, when the field ends); a quote that never closes is a literal
// character and the text after it is read again as unquoted
// (unterminated_quote); a quote inside an unquoted field is a literal
// character; fields stay strings, never trimmed or converted. columns is
// the first record when header is true, else null; rows holds the records
// after it, each padded with "" (short_row) or cut (long_row) to the first
// record's width. Each error is {code, line, row}, line the 1-based line
// its record starts on, row its record's index in rows (null for the
// header), in the order met.
//
// Speed comes from never walking the text one character at a time: plain
// lines with no quote at all are split on commas, plain fields are sliced
// between delimiters found with indexOf, and a quoted field is sliced
// whole when its body holds no line break and no doubled quote.
// The slow character-level work only runs on the rare broken pieces
// (a stray CR, a doubled quote, a line break inside quotes, junk after a
// closing quote, a quote that never closes).

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows.
  let recordLine = 1;
  let recordRow = null;

  // The field just read.
  let fv = '';
  let fe = END;

  // Record one stray_cr error per CR dropped.
  function stray(count) {
    for (let i = 0; i < count; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
  }

  // Drop every lone CR from s, recording one stray_cr error per CR.
  // Every CR in s is lone here: any CR followed by LF would have ended
  // the field at that LF instead.
  function dropCrs(s) {
    let count = 0;
    let at = s.indexOf('\r');
    while (at !== -1) {
      count++;
      at = s.indexOf('\r', at + 1);
    }
    stray(count);
    return s.split('\r').join('');
  }

  // Read one unquoted field starting at pos, with `prefix` already in its
  // value. Sets fv/fe, advances pos and line. The next comma bounds the
  // slice, so the search for a line break inside it only ever scans the
  // field itself, never the rest of the line.
  function unquoted(prefix) {
    const cIdx = text.indexOf(',', pos);
    if (cIdx !== -1) {
      const v0 = text.slice(pos, cIdx);
      const ni = v0.indexOf('\n');
      if (ni === -1) {
        pos = cIdx + 1;
        fe = COMMA;
        let v = v0;
        if (v.indexOf('\r') !== -1) v = dropCrs(v);
        fv = prefix === '' ? v : prefix + v;
        return;
      }
      let end = ni;
      if (end > 0 && v0.charCodeAt(end - 1) === 13) end--;
      let v = v0.slice(0, end);
      pos = pos + ni + 1;
      line++;
      fe = BREAK;
      if (v.indexOf('\r') !== -1) v = dropCrs(v);
      fv = prefix === '' ? v : prefix + v;
      return;
    }
    const nIdx = text.indexOf('\n', pos);
    if (nIdx !== -1) {
      let end = nIdx;
      if (end > pos && text.charCodeAt(end - 1) === 13) end--;
      let v = text.slice(pos, end);
      pos = nIdx + 1;
      line++;
      fe = BREAK;
      if (v.indexOf('\r') !== -1) v = dropCrs(v);
      fv = prefix === '' ? v : prefix + v;
      return;
    }
    let v = text.slice(pos);
    pos = n;
    fe = END;
    if (v.indexOf('\r') !== -1) v = dropCrs(v);
    fv = prefix === '' ? v : prefix + v;
  }

  // Build a quoted field's body from the slice [start, end): every '"' in
  // it is the first half of a "" pair, every CR or CRLF becomes one LF
  // and counts one line. Runs only on bodies with a doubled quote or a
  // line break inside them.
  function quotedBody(start, end) {
    const parts = [];
    let s = start;
    while (s < end) {
      let qi = text.indexOf('"', s);
      if (qi === -1 || qi > end) qi = end;
      let ri = text.indexOf('\r', s);
      if (ri === -1 || ri > end) ri = end;
      let ni = text.indexOf('\n', s);
      if (ni === -1 || ni > end) ni = end;
      const m = qi < ri ? (qi < ni ? qi : ni) : (ri < ni ? ri : ni);
      if (m === end) {
        parts.push(text.slice(s, end));
        break;
      }
      if (m > s) parts.push(text.slice(s, m));
      if (m === qi) {
        parts.push('"');
        s = m + 2;
      } else if (m === ri) {
        parts.push('\n');
        line++;
        s = text.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
      } else {
        parts.push('\n');
        line++;
        s = m + 1;
      }
    }
    return parts.join('');
  }

  // Read one quoted field whose opening quote is at pos. Sets fv/fe.
  function quotedField() {
    const open = pos;
    let q = open + 1;
    let escaped = false;
    let close = -1;
    for (;;) {
      q = text.indexOf('"', q);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        escaped = true;
        q += 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      unquoted('"');
      return;
    }
    // The body is sliced whole when it holds no line break and no doubled
    // quote; the checks only ever scan the body itself.
    let v = text.slice(open + 1, close);
    if (escaped || v.indexOf('\n') !== -1 || v.indexOf('\r') !== -1) {
      v = quotedBody(open + 1, close);
    }
    pos = close + 1;
    if (pos >= n) {
      fv = v;
      fe = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      fv = v;
      fe = COMMA;
      return;
    }
    if (c === 10) {
      pos++;
      line++;
      fv = v;
      fe = BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      fv = v;
      fe = BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break; stray CRs inside it still error first.
    unquoted(v);
    if (fv.length > v.length) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // File one record away: pad or cut it to the first record's width, and
  // skip a line that held only stray CRs (one empty unquoted field).
  function finish(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a whole line with no quote and no stray CR in it is plain
    // fields only. Its line break is the next LF (or the end of the text);
    // a CR at the very end of it is the CRLF half. The checks only ever
    // scan the line itself, and any quote or stray CR in it sends the
    // record to the slow path below, with pos and line untouched.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    let end = lineEnd;
    if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end--;
    const seg = text.slice(pos, end);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      const fields = seg.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line++;
      finish(fields, false);
      continue;
    }

    // Slow path: the line holds a quote, so read it field by field.
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) quotedField();
      else unquoted('');
      fields.push(fv);
    } while (fe === COMMA);
    finish(fields, quoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
