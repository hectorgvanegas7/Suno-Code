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

// El prompt puede re-escribir un nombre fonéticamente para que Suno lo cante
// bien (ej. "Jamie" -> "Yeimi") — ver PHONETIC RE-SPELLING en el SYSTEM_PROMPT
// de run.js y la regla de hardValidate() en lib/song-validate.js que solo
// exige que la primera letra coincida. verify-audio.js comparaba missingNames
// solo contra el nombre CRUDO de la encuesta, así que una respelling fonética
// legítima se marcaba "ausente" y quemaba auto-rerolls en vano (ver LESSONS.md).
//
// Esta función extrae la primera palabra de cada [Chorus N] de la letra ya
// generada y la empareja con el nombre de encuesta más probable (misma regla
// que hardValidate: coincidencia exacta o misma primera letra). Devuelve un
// mapa { nombreDeEncuesta: variantaFoneticaUsadaEnLaLetra }.
function extractLyricNameVariants(lyricsText, firstNames) {
  const variants = {};
  if (!lyricsText || !firstNames || firstNames.length === 0) return variants;

  const chorusOpeners = [];
  const chorusRegex = /\[Chorus\s*\d+\]\s*\n([^\n]+)/gi;
  let m;
  while ((m = chorusRegex.exec(lyricsText)) !== null) {
    const firstWord = m[1]
      .split(/[\s,!¡.…]+/)[0]
      ?.toLowerCase()
      .replace(/[^a-záéíóúüñ]/gi, '');
    if (firstWord) chorusOpeners.push(firstWord);
  }
  if (chorusOpeners.length === 0) return variants;

  if (firstNames.length === 1) {
    // Single destinatario: cero ambigüedad — cualquier apertura de Chorus ES
    // el nombre de esa única persona, reescrito fonéticamente o no. La
    // respelling real puede cambiar hasta la primera letra (Jamie -> Yeimi),
    // así que acá NO se exige coincidencia de letra.
    variants[firstNames[0]] = chorusOpeners[0];
    return variants;
  }

  // Multi-destinatario: song.txt no conserva el flag `foneticaAplicada` del
  // JSON original, así que la única heurística disponible para atribuir cada
  // apertura de Chorus a un nombre es la misma que ya usa hardValidate:
  // igualdad exacta o misma primera letra.
  for (const opener of chorusOpeners) {
    const matched = firstNames.find((n) => opener === n || opener[0] === n[0]);
    if (matched && !variants[matched]) variants[matched] = opener;
  }
  return variants;
}

// Palabras capitalizadas comunes que arrancan oración en inglés/español y NO
// son nombres propios — sin este stoplist, "El", "Cuando", "Nunca" etc. al
// inicio de una respuesta de encuesta se colarían como "nombre propio" y
// blindarían un typo real que coincida por casualidad.
const CAPITALIZED_STOPWORDS = new Set([
  'El', 'La', 'Los', 'Las', 'Un', 'Una', 'Unos', 'Unas', 'De', 'Del', 'Al',
  'Y', 'O', 'Que', 'Como', 'Cuando', 'Donde', 'Para', 'Por', 'Con', 'Sin',
  'Su', 'Sus', 'Mi', 'Mis', 'Tu', 'Tus', 'Nos', 'Nosotros', 'Ella', 'Ellos',
  'Ellas', 'Es', 'Fue', 'Era', 'Este', 'Esta', 'Estos', 'Estas', 'Ese', 'Esa',
  'Esos', 'Esas', 'No', 'Si', 'Muy', 'Mas', 'Pero', 'Porque', 'Cada', 'Todo',
  'Toda', 'Todos', 'Todas', 'Nunca', 'Siempre', 'Aqui', 'Alli', 'Especial',
  'Momentos', 'The', 'A', 'What', 'Their', 'Name', 'Recipient',
]);

// Extrae palabras capitalizadas (candidatos a nombre propio: persona, lugar,
// mascota) mencionadas literalmente en la encuesta — texto de origen 100%
// confiable, nunca inventado por el LLM. Se usa para excluir del gate de
// LanguageTool (Capa 2) cualquier "error ortográfico" que en realidad sea un
// dato real de la encuesta (bug real: "Jenner", el nombre de un lugar
// mencionado en "Special moments together", LanguageTool lo marcó como typo
// de "Tener" y el corrector automático lo reemplazó en la letra — ver
// LESSONS.md). A diferencia de extractFirstNames (busca el campo específico
// de nombre del destinatario), esto barre TODA la encuesta porque un dato
// factual protegido por "nada inventado" puede aparecer en cualquier campo
// (lugar, mascota, apodo, etc.), no solo en el de nombre.
function extractSurveyProperNouns(surveyText) {
  if (!surveyText) return [];
  const matches = surveyText.match(/\b[A-ZÁÉÍÓÚÑ][a-záéíóúüñ]{2,}\b/g) || [];
  return [...new Set(matches)].filter((w) => !CAPITALIZED_STOPWORDS.has(w));
}

module.exports = {
  extractFirstNames,
  extractLyricNameVariants,
  extractSurveyProperNouns,
};
