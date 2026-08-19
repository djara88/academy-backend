const { resolveCompetitiveProfile } = require('./competitiveStatsCatalog');

const FORMATS = Object.freeze({
  seguimiento: {
    code: 'seguimiento',
    label: 'Seguimiento de campeonato externo',
    description: 'Lestra registra convocados, cobros, agenda y resultados, pero la organización oficial del campeonato la administra un tercero.',
    structure: false,
    blueprint: ['Convocados de la academia', 'Agenda oficial', 'Resultados de nuestros deportistas', 'Resumen para familias'],
  },
  liga: {
    code: 'liga',
    label: 'Liga / todos contra todos',
    description: 'Cada competidor enfrenta a los demás y se construye una tabla de posiciones.',
    structure: true,
    blueprint: ['Divisiones', 'Equipos / competidores', 'Fechas del fixture', 'Tabla de posiciones', 'Campeón'],
  },
  grupos_eliminacion: {
    code: 'grupos_eliminacion',
    label: 'Grupos + eliminación directa',
    description: 'Primera fase por grupos y luego llaves de eliminación con los clasificados.',
    structure: true,
    blueprint: ['Divisiones', 'Grupos', 'Partidos de grupo', 'Clasificación', 'Llaves', 'Final / posiciones'],
  },
  eliminacion_directa: {
    code: 'eliminacion_directa',
    label: 'Eliminación directa',
    description: 'Llave en la que quien pierde queda eliminado hasta definir al campeón.',
    structure: true,
    blueprint: ['Divisiones', 'Siembra / sorteo', 'Llave inicial', 'Rondas', 'Semifinal', 'Final'],
  },
  doble_eliminacion: {
    code: 'doble_eliminacion',
    label: 'Doble eliminación',
    description: 'El competidor queda fuera después de dos derrotas. Útil en algunas competencias individuales.',
    structure: true,
    blueprint: ['Siembra', 'Llave de ganadores', 'Llave de perdedores', 'Cruces finales', 'Final'],
  },
  pools: {
    code: 'pools',
    label: 'Pools / grupos individuales',
    description: 'Pequeños grupos de deportistas compiten entre sí antes de una clasificación o llave posterior.',
    structure: true,
    blueprint: ['Divisiones', 'Pools', 'Combates / partidos internos', 'Ranking de pool', 'Clasificación'],
  },
  repechaje: {
    code: 'repechaje',
    label: 'Llaves con repechaje',
    description: 'Eliminación con una vía adicional de clasificación o disputa de posiciones/medallas.',
    structure: true,
    blueprint: ['Siembra', 'Llave principal', 'Repechaje', 'Semifinales / medallas', 'Final'],
  },
  rondas_clasificacion: {
    code: 'rondas_clasificacion',
    label: 'Rondas de clasificación',
    description: 'Resultados por ronda, serie, aparato o presentación con avance a etapas posteriores.',
    structure: true,
    blueprint: ['Divisiones / modalidades', 'Ronda clasificatoria', 'Corte / avance', 'Ronda final', 'Posiciones'],
  },
  pruebas_ranking: {
    code: 'pruebas_ranking',
    label: 'Pruebas + ranking',
    description: 'Cada deportista participa en una o varias pruebas y se clasifica por marca, tiempo, puntaje o posición.',
    structure: true,
    blueprint: ['Pruebas / modalidades', 'Series o intentos', 'Marcas / puntajes', 'Ranking', 'Podios / medallas'],
  },
  personalizado: {
    code: 'personalizado',
    label: 'Estructura personalizada',
    description: 'Permite construir fases y reglas propias cuando el campeonato no encaja en un formato estándar.',
    structure: true,
    blueprint: ['Divisiones', 'Fases configurables', 'Competidores', 'Resultados', 'Clasificación personalizada'],
  },
});

const TEAM = new Set(['futbol', 'futsal', 'basquetbol', 'voleibol', 'hockey', 'rugby']);
const RACKET = new Set(['tenis', 'padel']);
const COMBAT = new Set(['karate', 'artes_marciales']);
const RANKING = new Set(['natacion', 'atletismo', 'gimnasia']);

const recommendedCodes = (profile) => {
  const code = profile?.code || 'generico';
  if (TEAM.has(code)) return ['seguimiento', 'liga', 'grupos_eliminacion', 'eliminacion_directa', 'personalizado'];
  if (RACKET.has(code)) return ['seguimiento', 'eliminacion_directa', 'grupos_eliminacion', 'pools', 'doble_eliminacion', 'personalizado'];
  if (COMBAT.has(code)) return ['seguimiento', 'eliminacion_directa', 'pools', 'repechaje', 'rondas_clasificacion', 'personalizado'];
  if (RANKING.has(code)) return ['seguimiento', 'pruebas_ranking', 'rondas_clasificacion', 'personalizado'];
  return ['seguimiento', 'liga', 'eliminacion_directa', 'pruebas_ranking', 'personalizado'];
};

const publicCompetitionArchitecture = ({ discipline, code } = {}) => {
  const profile = resolveCompetitiveProfile({ discipline, code });
  const codes = recommendedCodes(profile);
  return {
    sport: {
      code: profile.code,
      label: profile.label,
      icon: profile.icon,
      usesHeadToHeadScore: profile.usesHeadToHeadScore,
    },
    managementTypes: [
      {
        code: 'externo',
        label: 'Participamos en un campeonato externo',
        description: 'La organización, fixture o llaves pertenecen a un tercero. Lestra se concentra en nuestros deportistas, cobros, citaciones y resultados.',
      },
      {
        code: 'organizado',
        label: 'La academia organiza la competencia',
        description: 'Lestra podrá administrar divisiones, competidores, fases, fixture, llaves y clasificación del campeonato.',
      },
    ],
    formats: codes.map((formatCode, index) => ({
      ...FORMATS[formatCode],
      recommended: index === 1 && formatCode !== 'personalizado',
    })),
  };
};

const getFormat = (code) => FORMATS[String(code || '').trim()] || null;

module.exports = {
  FORMATS,
  getFormat,
  publicCompetitionArchitecture,
};
