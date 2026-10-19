const { randomBytes } = require('node:crypto');

// Strong temporary credentials: 192 bits of CSPRNG entropy plus guaranteed
// complexity characters for downstream password policy compatibility.
const generateTemporaryPassword = () => `${randomBytes(24).toString('base64url')}Aa1!`;

module.exports = { generateTemporaryPassword };
