function parse(text) {
  if (typeof text !== 'string') throw Error('CSV text required');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"') throw Error('Malformed CSV quoting');
    else field += c;
  }
  if (quoted) throw Error('Unclosed CSV quote');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}
const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
module.exports = { parse, cell };
