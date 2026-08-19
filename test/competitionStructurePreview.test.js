const test = require('node:test');
const assert = require('node:assert/strict');
const { roundRobin, eliminationBracket, grouped, generateCompetitionPreview } = require('../services/competitionStructurePreview');

const rows = (count) => Array.from({ length: count }, (_, index) => ({
  id: `c${index + 1}`,
  nombre: `Competidor ${index + 1}`,
  tipo: 'equipo',
  origen: index === 0 ? 'academia' : 'externo',
  seed: index + 1,
  estado: 'Activo',
}));

const unorderedPairKey = (a, b) => [a.id, b.id].sort().join(':');

test('round robin par genera cada cruce exactamente una vez', () => {
  const competitors = rows(4);
  const rounds = roundRobin(competitors);
  assert.equal(rounds.length, 3);
  const pairs = rounds.flatMap((round) => round.matches.map((match) => unorderedPairKey(match.a, match.b)));
  assert.equal(pairs.length, 6);
  assert.equal(new Set(pairs).size, 6);
});

test('round robin impar usa bye sin crear cruces falsos', () => {
  const competitors = rows(5);
  const rounds = roundRobin(competitors);
  assert.equal(rounds.length, 5);
  const pairs = rounds.flatMap((round) => round.matches.map((match) => unorderedPairKey(match.a, match.b)));
  assert.equal(pairs.length, 10);
  assert.equal(new Set(pairs).size, 10);
});

test('eliminación directa completa potencia de dos y marca bye', () => {
  const bracket = eliminationBracket(rows(6));
  assert.equal(bracket.size, 8);
  assert.equal(bracket.matches.length, 4);
  assert.equal(bracket.matches.filter((match) => match.bye).length, 2);
  const present = bracket.matches.flatMap((match) => [match.a, match.b]).filter(Boolean);
  assert.equal(new Set(present.map((item) => item.id)).size, 6);
});

test('grupos distribuye a todos sin duplicarlos', () => {
  const groups = grouped(rows(10), 4);
  assert.equal(groups.length, 3);
  const competitors = groups.flatMap((group) => group.competitors);
  assert.equal(competitors.length, 10);
  assert.equal(new Set(competitors.map((item) => item.id)).size, 10);
});

test('preview nunca declara persistencia de partidos', () => {
  const preview = generateCompetitionPreview({
    tournament: { formato_competencia: 'liga', config_competencia: {} },
    division: { formato_competencia: 'liga', config: {} },
    phases: [],
    competitors: rows(4),
  });
  assert.equal(preview.persistsMatches, false);
  assert.equal(preview.mode, 'round_robin');
  assert.equal(preview.rounds.length, 3);
});
