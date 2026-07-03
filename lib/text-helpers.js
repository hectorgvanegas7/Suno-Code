function extractFirstNames(surveyText) {
  const nameFieldRaw =
    (surveyText.match(/What['']s their name\??:\s*([^\n]+)/i) ||
      surveyText.match(/recipient(?:['']s)? name\??:\s*([^\n]+)/i) ||
      surveyText.match(/Nombre[^:]*:\s*([^\n]+)/i) || [])[1] || '';
      
  const NAME_FIELD_FILLER_WORDS = new Set([
    'mis', 'mi', 'su', 'sus', 'el', 'la', 'los', 'las', 'de', 'del',
    'hijo', 'hija', 'hijos', 'hijas', 'y', 'and', 'e',
  ]);

  return [
    ...new Set(
      nameFieldRaw
        .replace(/[.,]/g, ' ')
        .split(/\s+/)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 1 && !NAME_FIELD_FILLER_WORDS.has(w))
    ),
  ];
}

module.exports = {
  extractFirstNames
};
