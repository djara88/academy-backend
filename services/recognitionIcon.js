const emojiToTwemojiUrl = (emoji) => {
  const value = String(emoji || '').trim();
  if (!value) return null;
  const codepoints = Array.from(value)
    .map((char) => char.codePointAt(0).toString(16))
    .filter((codepoint) => codepoint !== 'fe0f')
    .join('-');
  if (!codepoints) return null;
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codepoints}.png`;
};

const withRecognitionImage = (award = {}) => ({
  ...award,
  icono_url: award.icono_url || emojiToTwemojiUrl(award.emoji),
});

module.exports = {
  emojiToTwemojiUrl,
  withRecognitionImage,
};
