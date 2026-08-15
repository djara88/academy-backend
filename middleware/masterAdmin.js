const getMasterAdminEmail = () => (
  String(process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase()
);

const isMasterAdminEmail = (email) => {
  const configuredEmail = getMasterAdminEmail();
  if (!configuredEmail) return false;
  return String(email || '').trim().toLowerCase() === configuredEmail;
};

module.exports = { getMasterAdminEmail, isMasterAdminEmail };
