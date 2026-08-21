const getMasterAdminEmail = () => (
  String(process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase()
);

const getMasterAdminUserId = () => (
  String(process.env.SUPERADMIN_USER_ID || '').trim()
);

const isMasterAdminEmail = (email) => {
  const configuredEmail = getMasterAdminEmail();
  if (!configuredEmail) return false;
  return String(email || '').trim().toLowerCase() === configuredEmail;
};

const isMasterAdminUser = (user) => {
  const configuredUserId = getMasterAdminUserId();
  if (configuredUserId) return String(user?.id || '').trim() === configuredUserId;
  return isMasterAdminEmail(user?.email);
};

module.exports = {
  getMasterAdminEmail,
  getMasterAdminUserId,
  isMasterAdminEmail,
  isMasterAdminUser,
};
