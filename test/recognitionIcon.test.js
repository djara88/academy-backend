const test = require('node:test');
const assert = require('node:assert/strict');
const { emojiToTwemojiUrl, withRecognitionImage } = require('../services/recognitionIcon');

test('convierte emoji simple a PNG estable para el informe', () => {
  assert.equal(
    emojiToTwemojiUrl('🌟'),
    'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f31f.png',
  );
});

test('elimina selector de variación al construir la imagen', () => {
  assert.equal(
    emojiToTwemojiUrl('🏅️'),
    'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3c5.png',
  );
});

test('respeta una imagen personalizada existente', () => {
  const award = withRecognitionImage({ emoji: '🌟', icono_url: 'https://example.com/medalla.png' });
  assert.equal(award.icono_url, 'https://example.com/medalla.png');
});

test('usa el emoji como imagen cuando la medalla no tiene icono_url', () => {
  const award = withRecognitionImage({ nombre: 'Superación personal', emoji: '📈' });
  assert.equal(award.icono_url, 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4c8.png');
});
