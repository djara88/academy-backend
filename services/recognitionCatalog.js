const { resolveDisciplineCode } = require('./evaluationCatalog');

const MAX_CUSTOM_RECOGNITIONS = 20;

const recognition = (code, name, emoji, kind, description) => Object.freeze({
  code,
  name,
  emoji,
  kind,
  description,
  source: 'syncademia',
});

const COMMON_FORMATION = Object.freeze([
  recognition('formacion_constancia', 'Constancia y compromiso', '🌱', 'formacion', 'Mantiene asistencia, esfuerzo y compromiso sostenido con su proceso.'),
  recognition('formacion_companerismo', 'Compañerismo destacado', '🤝', 'formacion', 'Aporta positivamente al grupo, ayuda y respeta a sus compañeros.'),
  recognition('formacion_superacion', 'Superación personal', '📈', 'formacion', 'Evidencia un avance significativo respecto de su propio punto de partida.'),
  recognition('formacion_liderazgo', 'Liderazgo positivo', '👑', 'formacion', 'Influye de manera constructiva y promueve una cultura deportiva sana.'),
  recognition('formacion_respeto', 'Respeto y disciplina', '🧭', 'formacion', 'Destaca por autocontrol, respeto a normas, rivales, profesores y compañeros.'),
  recognition('formacion_actitud', 'Actitud positiva', '✨', 'formacion', 'Enfrenta entrenamientos, correcciones y desafíos con disposición de aprendizaje.'),
]);

const DISCIPLINE_RECOGNITIONS = Object.freeze({
  futbol: {
    formation: [
      recognition('futbol_lectura_juego', 'Lectura de juego en progreso', '🧠', 'formacion', 'Mejora su comprensión de espacios, apoyos y toma de decisiones.'),
      recognition('futbol_tecnica_progreso', 'Progreso técnico con balón', '⚽', 'formacion', 'Muestra evolución sostenida en control, pase y ejecución técnica.'),
    ],
    competition: [
      recognition('futbol_mvp', 'Deportista destacado del partido', '🌟', 'competencia', 'Rendimiento integral sobresaliente durante la competencia.'),
      recognition('futbol_goleador', 'Definición destacada', '🥅', 'competencia', 'Destaca por eficacia ofensiva y capacidad de finalización.'),
      recognition('futbol_asistente', 'Generador/a de juego', '🎯', 'competencia', 'Crea ventajas, asistencias y oportunidades para el equipo.'),
      recognition('futbol_defensa', 'Solidez defensiva', '🛡️', 'competencia', 'Destaca en recuperación, anticipación y protección defensiva.'),
    ],
  },
  futsal: {
    formation: [
      recognition('futsal_decision', 'Decisión rápida en progreso', '🧠', 'formacion', 'Evoluciona en velocidad de lectura y elección bajo presión.'),
      recognition('futsal_tecnica', 'Técnica en espacio reducido', '⚽', 'formacion', 'Mejora control orientado, pase corto y resolución en espacios reducidos.'),
    ],
    competition: [
      recognition('futsal_mvp', 'Deportista destacado del partido', '🌟', 'competencia', 'Rendimiento integral sobresaliente en el encuentro.'),
      recognition('futsal_finalizacion', 'Finalización destacada', '🥅', 'competencia', 'Alta eficacia en situaciones de definición.'),
      recognition('futsal_creador', 'Creación de juego', '🎯', 'competencia', 'Genera ventajas mediante pase, movilidad y lectura ofensiva.'),
      recognition('futsal_defensa', 'Intensidad defensiva', '🛡️', 'competencia', 'Destaca por presión, coberturas y recuperaciones.'),
    ],
  },
  basquetbol: {
    formation: [
      recognition('basquet_fundamentos', 'Fundamentos en progreso', '🏀', 'formacion', 'Evidencia evolución en bote, pase, tiro y desplazamientos.'),
      recognition('basquet_lectura', 'Lectura colectiva en progreso', '🧠', 'formacion', 'Mejora decisiones, ocupación de espacios y juego colectivo.'),
    ],
    competition: [
      recognition('basquet_mvp', 'Deportista destacado del partido', '🌟', 'competencia', 'Rendimiento integral sobresaliente en el encuentro.'),
      recognition('basquet_anotador', 'Aporte ofensivo destacado', '🎯', 'competencia', 'Destaca en anotación y eficiencia ofensiva.'),
      recognition('basquet_rebote', 'Dominio del rebote', '💪', 'competencia', 'Aporte sobresaliente en rebotes ofensivos y defensivos.'),
      recognition('basquet_defensa', 'Impacto defensivo', '🛡️', 'competencia', 'Destaca en marcaje, robos, ayudas y protección defensiva.'),
    ],
  },
  voleibol: {
    formation: [
      recognition('voley_fundamentos', 'Fundamentos técnicos en progreso', '🏐', 'formacion', 'Mejora saque, recepción, colocación y ejecución técnica.'),
      recognition('voley_comunicacion', 'Comunicación de equipo', '📣', 'formacion', 'Coordina, comunica y aporta orden al funcionamiento colectivo.'),
    ],
    competition: [
      recognition('voley_mvp', 'Deportista destacado del partido', '🌟', 'competencia', 'Rendimiento integral sobresaliente en el encuentro.'),
      recognition('voley_saque', 'Saque destacado', '🎯', 'competencia', 'Genera ventaja mediante precisión, potencia y continuidad de saque.'),
      recognition('voley_recepcion', 'Recepción sobresaliente', '👐', 'competencia', 'Mantiene estabilidad y calidad en la primera acción.'),
      recognition('voley_red', 'Dominio en la red', '🧱', 'competencia', 'Destaca en ataque, bloqueo y lectura de juego en la red.'),
    ],
  },
  tenis: {
    formation: [
      recognition('tenis_consistencia', 'Consistencia en progreso', '🎾', 'formacion', 'Mejora continuidad, control y tolerancia al error durante el juego.'),
      recognition('tenis_autonomia', 'Autonomía competitiva', '🧠', 'formacion', 'Gestiona mejor decisiones, emociones y rutinas de juego.'),
    ],
    competition: [
      recognition('tenis_partido', 'Partido destacado', '🌟', 'competencia', 'Rendimiento sobresaliente en un encuentro competitivo.'),
      recognition('tenis_servicio', 'Servicio destacado', '🎯', 'competencia', 'Destaca por efectividad, colocación y presión desde el saque.'),
      recognition('tenis_red', 'Juego de red destacado', '🥅', 'competencia', 'Resuelve con eficacia aproximaciones y acciones en la red.'),
      recognition('tenis_resiliencia', 'Resiliencia competitiva', '🔥', 'competencia', 'Mantiene concentración y capacidad de reacción en momentos exigentes.'),
    ],
  },
  padel: {
    formation: [
      recognition('padel_posicion', 'Posicionamiento en progreso', '🎾', 'formacion', 'Evoluciona en ocupación de espacios, coberturas y coordinación con su pareja.'),
      recognition('padel_comunicacion', 'Comunicación de pareja', '🤝', 'formacion', 'Aporta coordinación, apoyo y toma de decisiones compartida.'),
    ],
    competition: [
      recognition('padel_partido', 'Partido destacado', '🌟', 'competencia', 'Rendimiento integral sobresaliente en competencia.'),
      recognition('padel_red', 'Dominio de la red', '🥅', 'competencia', 'Destaca en voleas, bandejas y ocupación ofensiva de la red.'),
      recognition('padel_defensa', 'Defensa destacada', '🛡️', 'competencia', 'Sostiene puntos exigentes y recupera posiciones con eficacia.'),
      recognition('padel_definicion', 'Definición destacada', '💥', 'competencia', 'Convierte oportunidades mediante remates y golpes de cierre.'),
    ],
  },
  hockey: {
    formation: [
      recognition('hockey_control', 'Control y conducción en progreso', '🏑', 'formacion', 'Mejora dominio del implemento, conducción y seguridad técnica.'),
      recognition('hockey_posicion', 'Comprensión táctica en progreso', '🧠', 'formacion', 'Evoluciona en ocupación de espacios, apoyos y marcaje.'),
    ],
    competition: [
      recognition('hockey_mvp', 'Deportista destacado del partido', '🌟', 'competencia', 'Rendimiento integral sobresaliente en el encuentro.'),
      recognition('hockey_creacion', 'Construcción de juego', '🎯', 'competencia', 'Aporta pases, progresiones y generación de oportunidades.'),
      recognition('hockey_recuperacion', 'Recuperación destacada', '🛡️', 'competencia', 'Destaca en intercepciones, marcaje y recuperación de posesión.'),
      recognition('hockey_definicion', 'Definición destacada', '🥅', 'competencia', 'Alta incidencia en remates y acciones de gol.'),
    ],
  },
  atletismo: {
    formation: [
      recognition('atletismo_tecnica', 'Técnica atlética en progreso', '🏃', 'formacion', 'Muestra evolución técnica acorde a su prueba o especialidad.'),
      recognition('atletismo_constancia', 'Constancia de entrenamiento', '⏱️', 'formacion', 'Sostiene hábitos, carga y continuidad de entrenamiento de manera responsable.'),
    ],
    competition: [
      recognition('atletismo_pb', 'Mejor marca personal', '🚀', 'competencia', 'Consigue una nueva mejor marca personal.'),
      recognition('atletismo_podio', 'Podio competitivo', '🏅', 'competencia', 'Obtiene posición de podio en una competencia.'),
      recognition('atletismo_ejecucion', 'Ejecución técnica destacada', '🎯', 'competencia', 'Realiza una ejecución competitiva técnicamente sobresaliente.'),
      recognition('atletismo_consistencia', 'Regularidad competitiva', '📈', 'competencia', 'Mantiene rendimiento estable y competitivo en sus presentaciones.'),
    ],
  },
  natacion: {
    formation: [
      recognition('natacion_tecnica', 'Técnica de nado en progreso', '🏊', 'formacion', 'Evidencia mejora en coordinación, respiración y eficiencia técnica.'),
      recognition('natacion_habitos', 'Hábitos de entrenamiento', '🌊', 'formacion', 'Destaca por constancia, orden y disciplina en sus sesiones.'),
    ],
    competition: [
      recognition('natacion_pb', 'Mejor marca personal', '🚀', 'competencia', 'Consigue una nueva mejor marca personal.'),
      recognition('natacion_podio', 'Podio competitivo', '🏅', 'competencia', 'Obtiene posición de podio en una competencia.'),
      recognition('natacion_salida', 'Salida y virajes destacados', '⚡', 'competencia', 'Ejecuta con alta calidad técnica salida, vueltas y transiciones.'),
      recognition('natacion_consistencia', 'Regularidad competitiva', '📈', 'competencia', 'Mantiene rendimiento estable entre pruebas y competencias.'),
    ],
  },
  gimnasia: {
    formation: [
      recognition('gimnasia_tecnica', 'Técnica en progreso', '🤸', 'formacion', 'Muestra evolución en ejecución, control y aprendizaje de elementos.'),
      recognition('gimnasia_disciplina', 'Disciplina de entrenamiento', '🎀', 'formacion', 'Destaca por concentración, hábitos y compromiso con la corrección técnica.'),
    ],
    competition: [
      recognition('gimnasia_ejecucion', 'Ejecución destacada', '🌟', 'competencia', 'Presenta una rutina o elemento de alta calidad competitiva.'),
      recognition('gimnasia_puntaje', 'Puntaje destacado', '🎯', 'competencia', 'Obtiene una calificación sobresaliente en competencia.'),
      recognition('gimnasia_podio', 'Podio competitivo', '🏅', 'competencia', 'Obtiene posición de podio en su aparato o categoría.'),
      recognition('gimnasia_control', 'Control corporal destacado', '✨', 'competencia', 'Destaca en estabilidad, precisión y dominio corporal.'),
    ],
  },
  artes_marciales: {
    formation: [
      recognition('marcial_espiritu', 'Espíritu marcial', '🥋', 'formacion', 'Demuestra respeto, autocontrol, disciplina y humildad en su proceso.'),
      recognition('marcial_tecnica', 'Técnica en progreso', '🎯', 'formacion', 'Evidencia mejora sostenida en postura, ejecución, control y precisión.'),
      recognition('marcial_autocontrol', 'Autocontrol destacado', '🧘', 'formacion', 'Gestiona intensidad, emociones y conducta con madurez deportiva.'),
    ],
    competition: [
      recognition('marcial_combate', 'Combate destacado', '🌟', 'competencia', 'Rendimiento integral sobresaliente en combate o enfrentamiento.'),
      recognition('marcial_tecnica_comp', 'Técnica competitiva destacada', '🥋', 'competencia', 'Ejecuta técnicas con alta precisión, control y eficacia.'),
      recognition('marcial_podio', 'Medalla / podio competitivo', '🏅', 'competencia', 'Obtiene medalla o posición de podio en competencia.'),
      recognition('marcial_tactica', 'Lectura táctica destacada', '🧠', 'competencia', 'Toma decisiones oportunas y adapta su estrategia durante la competencia.'),
    ],
  },
  rugby: {
    formation: [
      recognition('rugby_fundamentos', 'Fundamentos en progreso', '🏉', 'formacion', 'Evidencia avance en pase, recepción, contacto y desplazamiento.'),
      recognition('rugby_equipo', 'Espíritu de equipo', '🤝', 'formacion', 'Destaca por apoyo, respeto y compromiso con el funcionamiento colectivo.'),
    ],
    competition: [
      recognition('rugby_mvp', 'Deportista destacado del partido', '🌟', 'competencia', 'Rendimiento integral sobresaliente en el encuentro.'),
      recognition('rugby_tackle', 'Defensa / tackle destacado', '🛡️', 'competencia', 'Alto impacto defensivo mediante tackles y recuperaciones.'),
      recognition('rugby_ataque', 'Impacto ofensivo', '🔥', 'competencia', 'Destaca en tries, metros ganados y generación de ventajas.'),
      recognition('rugby_apoyo', 'Apoyo y continuidad', '🔗', 'competencia', 'Aporta continuidad de juego y soporte constante a sus compañeros.'),
    ],
  },
  generico: {
    formation: [
      recognition('generico_tecnica', 'Progreso técnico', '🎯', 'formacion', 'Muestra evolución sostenida en fundamentos propios de su disciplina.'),
      recognition('generico_aprendizaje', 'Aprendizaje destacado', '🧠', 'formacion', 'Integra correcciones y nuevos aprendizajes con rapidez y consistencia.'),
    ],
    competition: [
      recognition('generico_destacado', 'Deportista destacado/a', '🌟', 'competencia', 'Rendimiento integral sobresaliente en competencia.'),
      recognition('generico_podio', 'Podio competitivo', '🏅', 'competencia', 'Obtiene posición de podio o logro competitivo equivalente.'),
      recognition('generico_tecnica_comp', 'Ejecución técnica destacada', '🎯', 'competencia', 'Presenta una ejecución técnica de alta calidad en competencia.'),
      recognition('generico_resiliencia', 'Resiliencia competitiva', '🔥', 'competencia', 'Mantiene concentración y respuesta positiva frente a la exigencia competitiva.'),
    ],
  },
});

const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

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
    const kind = raw?.kind === 'competencia' ? 'competencia' : 'formacion';
    const description = String(raw?.description || raw?.descripcion || '').trim().replace(/\s+/g, ' ').slice(0, 240);
    const baseCode = String(raw?.code || raw?.id || key.replace(/[^a-z0-9]+/g, '_')).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || `reconocimiento_${output.length + 1}`;
    output.push({
      code: `custom_${baseCode.replace(/^custom_/, '')}`,
      name,
      emoji: safeEmoji(raw?.emoji),
      kind,
      description,
      source: 'academy',
    });
    if (output.length >= MAX_CUSTOM_RECOGNITIONS) break;
  }
  return output;
};

const getStandardRecognitions = (discipline) => {
  const code = resolveDisciplineCode(discipline);
  const specific = DISCIPLINE_RECOGNITIONS[code] || DISCIPLINE_RECOGNITIONS.generico;
  return [...COMMON_FORMATION, ...(specific.formation || []), ...(specific.competition || [])];
};

const getRecognitionCatalog = ({ discipline, customConfig, allowCustom = false } = {}) => {
  const standard = getStandardRecognitions(discipline);
  const custom = allowCustom ? sanitizeCustomRecognitions(customConfig) : [];
  return {
    standard,
    custom,
    all: [...standard, ...custom],
    customization: {
      allowed: Boolean(allowCustom),
      active: custom.length > 0,
      maxItems: MAX_CUSTOM_RECOGNITIONS,
    },
  };
};

const findRecognition = ({ discipline, code, customConfig, allowCustom = false } = {}) => {
  const normalizedCode = String(code || '').trim();
  return getRecognitionCatalog({ discipline, customConfig, allowCustom }).all.find((item) => item.code === normalizedCode) || null;
};

module.exports = {
  MAX_CUSTOM_RECOGNITIONS,
  COMMON_FORMATION,
  DISCIPLINE_RECOGNITIONS,
  sanitizeCustomRecognitions,
  getStandardRecognitions,
  getRecognitionCatalog,
  findRecognition,
};
