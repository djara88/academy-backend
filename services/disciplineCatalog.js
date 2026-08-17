const ALLOWED_DISCIPLINES = Object.freeze([
  'Fútbol', 'Futsal', 'Básquetbol', 'Vóleibol', 'Tenis', 'Pádel', 'Hockey',
  'Atletismo', 'Natación', 'Gimnasia', 'Karate', 'Artes marciales', 'Rugby', 'Otro',
]);

const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const disciplineMap = new Map(ALLOWED_DISCIPLINES.map((item) => [normalizeText(item), item]));
const aliases = new Map([
  ['futbol', 'Fútbol'], ['football', 'Fútbol'], ['basket', 'Básquetbol'], ['basketbol', 'Básquetbol'],
  ['basquet', 'Básquetbol'], ['volley', 'Vóleibol'], ['voleibol', 'Vóleibol'], ['tennis', 'Tenis'],
  ['padel', 'Pádel'], ['natacion', 'Natación'], ['gimnasia', 'Gimnasia'], ['karate-do', 'Karate'],
  ['karate do', 'Karate'], ['artes marciales', 'Artes marciales'],
]);

const resolveDiscipline = (value) => {
  const key = normalizeText(value);
  return disciplineMap.get(key) || aliases.get(key) || null;
};

const defaultBranchName = (discipline) => discipline === 'Otro' ? 'Disciplina principal' : discipline;

module.exports = { ALLOWED_DISCIPLINES, normalizeText, resolveDiscipline, defaultBranchName };
