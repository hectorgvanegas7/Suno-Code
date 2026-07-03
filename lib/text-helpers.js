function extractFirstNames(surveyText) {
  const nameFieldRaw =
    (surveyText.match(/What['']s their name\??:\s*([^\n]+)/i) ||
      surveyText.match(/recipient(?:['']s)? name\??:\s*([^\n]+)/i) ||
      surveyText.match(/Nombre[^:]*:\s*([^\n]+)/i) || [])[1] || '';
      
  const NAME_FIELD_FILLER_WORDS = new Set([
    'mis', 'mi', 'su', 'sus', 'el', 'la', 'los', 'las', 'de', 'del',
    'hijo', 'hija', 'hijos', 'hijas', 'esposo', 'esposa', 'madre', 'padre', 'hermano', 'hermana', 'esposos', 'padres', 'novio', 'novia'
  ]);

  // Dividir por conjunciones para separar múltiples personas (ej. "Juan y Maria")
  const parts = nameFieldRaw.split(/[,&]| y | and | e /i);
  
  const names = [];
  for (const part of parts) {
    const words = part.split(/\s+/)
      .map((w) => w.toLowerCase().replace(/[^a-záéíóúüñ]/gi, ''))
      .filter((w) => w.length > 1 && !NAME_FIELD_FILLER_WORDS.has(w));
    
    if (words.length > 0) {
      names.push(words[0]); // Tomar solo el primer nombre de cada persona, ignorando apellidos
    }
  }

  return [...new Set(names)];
}

module.exports = {
  extractFirstNames
};
