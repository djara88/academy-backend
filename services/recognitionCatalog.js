const { resolveDisciplineCode } = require('./evaluationCatalog');

const MAX_CUSTOM_RECOGNITIONS = 20;
const recognition = (code, name, emoji, kind, description) => Object.freeze({ code, name, emoji, kind, description, source: 'syncademia' });

const COMMON_FORMATION = Object.freeze([
  recognition('formacion_constancia', 'Constancia y compromiso', '🌱', 'formacion', 'Mantiene asistencia, esfuerzo y compromiso sostenido con su proceso.'),
  recognition('formacion_companerismo', 'Compañerismo destacado', '🤝', 'formacion', 'Aporta positivamente al grupo y respeta a sus compañeros.'),
  recognition('formacion_superacion', 'Superación personal', '📈', 'formacion', 'Evidencia un avance significativo respecto de su punto de partida.'),
  recognition('formacion_liderazgo', 'Liderazgo positivo', '👑', 'formacion', 'Influye de manera constructiva en el grupo.'),
  recognition('formacion_respeto', 'Respeto y disciplina', '🧭', 'formacion', 'Destaca por autocontrol, respeto a normas y convivencia deportiva.'),
  recognition('formacion_actitud', 'Actitud positiva', '✨', 'formacion', 'Recibe correcciones y desafíos con disposición de aprendizaje.'),
]);

const makeGroup = (prefix, formation, competition) => ({
  formation: formation.map(([code, name, emoji, description]) => recognition(`${prefix}_${code}`, name, emoji, 'formacion', description)),
  competition: competition.map(([code, name, emoji, description]) => recognition(`${prefix}_${code}`, name, emoji, 'competencia', description)),
});

const DISCIPLINE_RECOGNITIONS = Object.freeze({
  futbol: makeGroup('futbol', [
    ['lectura_juego', 'Lectura de juego en progreso', '🧠', 'Mejora espacios, apoyos y toma de decisiones.'],
    ['tecnica_progreso', 'Progreso técnico con balón', '⚽', 'Evoluciona en control, pase y ejecución técnica.'],
  ], [
    ['mvp', 'Deportista destacado del partido', '🌟', 'Rendimiento integral sobresaliente.'],
    ['goleador', 'Definición destacada', '🥅', 'Alta eficacia ofensiva y capacidad de finalización.'],
    ['defensa', 'Solidez defensiva', '🛡️', 'Destaca en recuperación, anticipación y protección defensiva.'],
  ]),
  futsal: makeGroup('futsal', [
    ['decision', 'Decisión rápida en progreso', '🧠', 'Evoluciona en lectura y elección bajo presión.'],
    ['tecnica', 'Técnica en espacio reducido', '⚽', 'Mejora control orientado, pase corto y resolución.'],
  ], [
    ['mvp', 'Deportista destacado del partido', '🌟', 'Rendimiento integral sobresaliente.'],
    ['finalizacion', 'Finalización destacada', '🥅', 'Alta eficacia en situaciones de definición.'],
    ['defensa', 'Intensidad defensiva', '🛡️', 'Destaca por presión, coberturas y recuperaciones.'],
  ]),
  basquetbol: makeGroup('basquet', [
    ['fundamentos', 'Fundamentos en progreso', '🏀', 'Evoluciona en bote, pase, tiro y desplazamientos.'],
    ['lectura', 'Lectura colectiva en progreso', '🧠', 'Mejora decisiones, espacios y juego colectivo.'],
  ], [
    ['mvp', 'Deportista destacado del partido', '🌟', 'Rendimiento integral sobresaliente.'],
    ['anotador', 'Aporte ofensivo destacado', '🎯', 'Destaca en anotación y eficiencia ofensiva.'],
    ['defensa', 'Impacto defensivo', '🛡️', 'Destaca en marcaje, robos y ayudas defensivas.'],
  ]),
  voleibol: makeGroup('voley', [
    ['fundamentos', 'Fundamentos técnicos en progreso', '🏐', 'Mejora saque, recepción, colocación y ataque.'],
    ['comunicacion', 'Comunicación de equipo', '📣', 'Coordina y aporta orden al funcionamiento colectivo.'],
  ], [
    ['mvp', 'Deportista destacado del partido', '🌟', 'Rendimiento integral sobresaliente.'],
    ['saque', 'Saque destacado', '🎯', 'Genera ventaja mediante precisión y potencia.'],
    ['red', 'Dominio en la red', '🧱', 'Destaca en ataque, bloqueo y lectura de red.'],
  ]),
  tenis: makeGroup('tenis', [
    ['consistencia', 'Consistencia en progreso', '🎾', 'Mejora continuidad, control y tolerancia al error.'],
    ['autonomia', 'Autonomía deportiva', '🧠', 'Gestiona mejor decisiones, emociones y rutinas.'],
  ], [
    ['partido', 'Partido destacado', '🌟', 'Rendimiento sobresaliente en competencia.'],
    ['servicio', 'Servicio destacado', '🎯', 'Destaca por efectividad y colocación desde el saque.'],
    ['resiliencia', 'Resiliencia competitiva', '🔥', 'Mantiene concentración en momentos exigentes.'],
  ]),
  padel: makeGroup('padel', [
    ['posicion', 'Posicionamiento en progreso', '🎾', 'Evoluciona en espacios, coberturas y coordinación.'],
    ['comunicacion', 'Comunicación de pareja', '🤝', 'Aporta coordinación y decisiones compartidas.'],
  ], [
    ['partido', 'Partido destacado', '🌟', 'Rendimiento integral sobresaliente.'],
    ['red', 'Dominio de la red', '🥅', 'Destaca en voleas, bandejas y ocupación ofensiva.'],
    ['defensa', 'Defensa destacada', '🛡️', 'Sostiene puntos exigentes y recupera posiciones.'],
  ]),
  hockey: makeGroup('hockey', [
    ['control', 'Control y conducción en progreso', '🏑', 'Mejora dominio, conducción y seguridad técnica.'],
    ['posicion', 'Comprensión táctica en progreso', '🧠', 'Evoluciona en espacios, apoyos y marcaje.'],
  ], [
    ['mvp', 'Deportista destacado del partido', '🌟', 'Rendimiento integral sobresaliente.'],
    ['creacion', 'Construcción de juego', '🎯', 'Aporta pases, progresiones y oportunidades.'],
    ['recuperacion', 'Recuperación destacada', '🛡️', 'Destaca en intercepciones y recuperación.'],
  ]),
  atletismo: makeGroup('atletismo', [
    ['tecnica', 'Técnica atlética en progreso', '🏃', 'Evoluciona técnicamente en su prueba o especialidad.'],
    ['constancia', 'Constancia de entrenamiento', '⏱️', 'Sostiene hábitos y continuidad de entrenamiento.'],
  ], [
    ['pb', 'Mejor marca personal', '🚀', 'Consigue una nueva mejor marca personal.'],
    ['podio', 'Podio competitivo', '🏅', 'Obtiene una posición de podio.'],
    ['ejecucion', 'Ejecución técnica destacada', '🎯', 'Realiza una ejecución competitiva sobresaliente.'],
  ]),
  natacion: makeGroup('natacion', [
    ['tecnica', 'Técnica de nado en progreso', '🏊', 'Mejora coordinación, respiración y eficiencia técnica.'],
    ['habitos', 'Hábitos de entrenamiento', '🌊', 'Destaca por constancia, orden y disciplina.'],
  ], [
    ['pb', 'Mejor marca personal', '🚀', 'Consigue una nueva mejor marca personal.'],
    ['podio', 'Podio competitivo', '🏅', 'Obtiene una posición de podio.'],
    ['salida', 'Salida y virajes destacados', '⚡', 'Ejecuta salida, vueltas y transiciones con alta calidad.'],
  ]),
  gimnasia: makeGroup('gimnasia', [
    ['tecnica', 'Técnica en progreso', '🤸', 'Evoluciona en ejecución, control y aprendizaje de elementos.'],
    ['disciplina', 'Disciplina de entrenamiento', '🎀', 'Destaca por concentración y compromiso técnico.'],
  ], [
    ['ejecucion', 'Ejecución destacada', '🌟', 'Presenta una rutina o elemento de alta calidad.'],
    ['puntaje', 'Puntaje destacado', '🎯', 'Obtiene una calificación sobresaliente.'],
    ['podio', 'Podio competitivo', '🏅', 'Obtiene una posición de podio.'],
  ]),
  karate: makeGroup('karate', [
    ['espiritu', 'Espíritu del dojo', '🥋', 'Demuestra respeto, autocontrol, disciplina y humildad.'],
    ['kihon', 'Progreso destacado en Kihon', '🎯', 'Evoluciona en posturas, técnica base, precisión y control.'],
    ['kata_progreso', 'Evolución en Kata', '🧘', 'Mejora secuencia, ritmo, equilibrio y concentración.'],
    ['kumite_control', 'Control y distancia en Kumite', '🛡️', 'Evoluciona en maai, timing, control y decisiones.'],
  ], [
    ['kata_destacado', 'Kata destacado', '🌟', 'Ejecución sobresaliente por técnica, ritmo, potencia y precisión.'],
    ['kumite_destacado', 'Kumite destacado', '🔥', 'Combate sobresaliente por estrategia, técnica y eficacia.'],
    ['podio', 'Podio competitivo de Karate', '🏅', 'Obtiene medalla o podio en Kata o Kumite.'],
    ['ippon', 'Técnica decisiva / Ippon', '⚡', 'Realiza una acción técnica decisiva de alta calidad.'],
  ]),
  artes_marciales: makeGroup('marcial', [
    ['espiritu', 'Espíritu marcial', '🥋', 'Demuestra respeto, autocontrol, disciplina y humildad.'],
    ['tecnica', 'Técnica en progreso', '🎯', 'Evoluciona en postura, ejecución, control y precisión.'],
  ], [
    ['combate', 'Combate destacado', '🌟', 'Rendimiento integral sobresaliente en combate.'],
    ['tecnica_comp', 'Técnica competitiva destacada', '🥋', 'Ejecuta técnicas con alta precisión y eficacia.'],
    ['podio', 'Medalla / podio competitivo', '🏅', 'Obtiene medalla o posición de podio.'],
  ]),
  rugby: makeGroup('rugby', [
    ['fundamentos', 'Fundamentos en progreso', '🏉', 'Evoluciona en pase, recepción, contacto y desplazamiento.'],
    ['equipo', 'Espíritu de equipo', '🤝', 'Destaca por apoyo, respeto y compromiso colectivo.'],
  ], [
    ['mvp', 'Deportista destacado del partido', '🌟', 'Rendimiento integral sobresaliente.'],
    ['tackle', 'Defensa / tackle destacado', '🛡️', 'Alto impacto defensivo mediante tackles y recuperaciones.'],
    ['ataque', 'Impacto ofensivo', '🔥', 'Destaca en tries, metros y generación de ventajas.'],
  ]),
  generico: makeGroup('generico', [
    ['tecnica', 'Progreso técnico', '🎯', 'Evoluciona en fundamentos propios de su disciplina.'],
    ['aprendizaje', 'Aprendizaje destacado', '🧠', 'Integra correcciones y nuevos aprendizajes con consistencia.'],
  ], [
    ['destacado', 'Deportista destacado/a', '🌟', 'Rendimiento integral sobresaliente en competencia.'],
    ['podio', 'Podio competitivo', '🏅', 'Obtiene podio o logro competitivo equivalente.'],
    ['resiliencia', 'Resiliencia competitiva', '🔥', 'Mantiene concentración frente a la exigencia competitiva.'],
  ]),
});

const normalizeText = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const safeEmoji = (value) => String(value || '').trim().slice(0, 8) || '🏅';

const sanitizeCustomRecognitions = (input) => {
  const source = Array.isArray(input?.items) ? input.items : Array.isArray(input) ? input : [];
  const output = [];
  const seen = new Set();
  for (const raw of source) {
    const name = String(raw?.name || raw?.nombre || '').trim().replace(/\s+/g, ' ').slice(0, 90);
    if (!name) continue;
    const key = normalizeText(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const baseCode = String(raw?.code || raw?.id || key.replace(/[^a-z0-9]+/g, '_')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || `reconocimiento_${output.length + 1}`;
    output.push({
      code: `custom_${baseCode.replace(/^custom_/, '')}`,
      name,
      emoji: safeEmoji(raw?.emoji),
      kind: raw?.kind === 'competencia' ? 'competencia' : 'formacion',
      description: String(raw?.description || raw?.descripcion || '').trim().replace(/\s+/g, ' ').slice(0, 240),
      source: 'academy',
    });
    if (output.length >= MAX_CUSTOM_RECOGNITIONS) break;
  }
  return output;
};

const getStandardRecognitions = (discipline) => {
  const specific = DISCIPLINE_RECOGNITIONS[resolveDisciplineCode(discipline)] || DISCIPLINE_RECOGNITIONS.generico;
  return [...COMMON_FORMATION, ...specific.formation, ...specific.competition];
};

const getRecognitionCatalog = ({ discipline, customConfig, allowCustom = false } = {}) => {
  const standard = getStandardRecognitions(discipline);
  const custom = allowCustom ? sanitizeCustomRecognitions(customConfig) : [];
  return { standard, custom, all: [...standard, ...custom], customization: { allowed: Boolean(allowCustom), active: custom.length > 0, maxItems: MAX_CUSTOM_RECOGNITIONS } };
};

const findRecognition = ({ discipline, code, customConfig, allowCustom = false } = {}) => getRecognitionCatalog({ discipline, customConfig, allowCustom }).all.find((item) => item.code === String(code || '').trim()) || null;

module.exports = {
  MAX_CUSTOM_RECOGNITIONS,
  COMMON_FORMATION,
  DISCIPLINE_RECOGNITIONS,
  sanitizeCustomRecognitions,
  getStandardRecognitions,
  getRecognitionCatalog,
  findRecognition,
};
