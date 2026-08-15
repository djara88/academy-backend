const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

const validatePassword = (password) => {
  const value = typeof password === 'string' ? password : '';
  const errors = [];

  if (value.length < PASSWORD_MIN_LENGTH) errors.push(`al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  if (value.length > PASSWORD_MAX_LENGTH) errors.push(`máximo ${PASSWORD_MAX_LENGTH} caracteres`);
  if (!/[a-z]/.test(value)) errors.push('una letra minúscula');
  if (!/[A-Z]/.test(value)) errors.push('una letra mayúscula');
  if (!/[0-9]/.test(value)) errors.push('un número');
  if (!/[^A-Za-z0-9]/.test(value)) errors.push('un símbolo');

  return {
    valid: errors.length === 0,
    errors,
    message: errors.length ? `La contraseña debe incluir ${errors.join(', ')}.` : null,
  };
};

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  validatePassword,
};
