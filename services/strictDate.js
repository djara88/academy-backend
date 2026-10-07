const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const parseStrictIsoDate = (value) => {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!ISO_DATE_PATTERN.test(text)) return null;

  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;

  return text;
};

module.exports = { ISO_DATE_PATTERN, parseStrictIsoDate };
