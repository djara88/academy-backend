const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'jerseyNumbers.js'), 'utf8');

test('mapa de dorsales usa el alcance real por categoría y expone su roster', () => {
  assert.match(source, /getActiveEnrollments\(\{[\s\S]*categoryId:\s*category\?\.id\s*\|\|\s*undefined/);
  assert.match(source, /const players = await getPlayersForEnrollments/);
  assert.match(source, /players:\s*players\.map/);
  assert.match(source, /jerseyNumber:\s*player\.numero_camiseta/);
});

test('excluir un alumno afecta ocupación, no el roster del alcance', () => {
  assert.match(source, /const availabilityPlayers = excludedPlayer/);
  assert.match(source, /availabilityPlayers[\s\S]*filter\(\(player\) => player\.numero_camiseta != null\)/);
  assert.doesNotMatch(source, /getPlayersForEnrollments\([\s\S]*scopedEnrollments/);
});
