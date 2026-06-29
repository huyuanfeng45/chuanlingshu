const SECRET_PATTERNS = [
  /(App\s*Secret\s*[:：]\s*)[A-Za-z0-9_\-]{8,}/gi,
  /(App\s*Secret\s*[:：]\s*\n\s*)[A-Za-z0-9_\-]{8,}/gi,
  /(app[_-]?secret["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-]{8,}/gi,
  /(secret["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-]{12,}/gi
];

function redactString(value) {
  let text = String(value || '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '$1***');
  }
  return text;
}

function redactDeep(value) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactDeep);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password/i.test(key)) {
      output[key] = item ? '***' : item;
    } else {
      output[key] = redactDeep(item);
    }
  }
  return output;
}

module.exports = {
  redactString,
  redactDeep
};
