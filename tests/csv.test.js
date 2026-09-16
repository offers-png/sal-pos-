const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, cell } = require('../services/csv');
test('CSV preserves empty columns, leading-zero barcodes, embedded quotes and multiline names', () => {
  const values = ['001234', '', 'Store "special", large\npack', '2.50'];
  assert.deepEqual(parse(values.map(cell).join(',')), [values]);
  assert.deepEqual(parse('a,b,c\r\n1,,3\r\n'), [['a','b','c'], ['1','','3']]);
  assert.throws(() => parse('"unfinished'), /Unclosed/);
});
