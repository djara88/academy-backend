const fs = require('node:fs');

const notifier = fs.readFileSync('services/academyRegistrationNotifier.js', 'utf8');
if (notifier.includes("require('../middleware/masterAdmin')") || notifier.includes('getMasterAdminEmail')) {
  throw new Error('Admin notification audit failed: notification delivery must not depend on authorization identity helpers.');
}
if (!notifier.includes('SUPERADMIN_NOTIFICATION_EMAIL')) {
  throw new Error('Admin notification audit failed: dedicated notification recipient configuration is missing.');
}

const masterAdmin = fs.readFileSync('middleware/masterAdmin.js', 'utf8');
if (/EMAIL/i.test(masterAdmin)) {
  throw new Error('Admin notification audit failed: master authorization module must remain UUID-only.');
}

console.log('Admin notification separation audit passed.');
