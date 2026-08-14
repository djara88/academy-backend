const DEFAULT_MASTER_ADMIN_EMAIL = 'd.jarazerene@gmail.com';

const getMasterAdminEmail = () => (
  process.env.SUPERADMIN_EMAIL || DEFAULT_MASTER_ADMIN_EMAIL
).trim().toLowerCase();

const isMasterAdminEmail = (email) => (
  String(email || '').trim().toLowerCase() === getMasterAdminEmail()
);

module.exports = { isMasterAdminEmail };
