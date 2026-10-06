const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getMasterAdminUserId = () => (
  String(process.env.SUPERADMIN_USER_ID || '').trim()
);

const isMasterAdminConfigured = () => UUID_PATTERN.test(getMasterAdminUserId());

const isMasterAdminUser = (user) => {
  const configuredUserId = getMasterAdminUserId();
  if (!UUID_PATTERN.test(configuredUserId)) return false;
  return String(user?.id || '').trim() === configuredUserId;
};

module.exports = {
  getMasterAdminUserId,
  isMasterAdminConfigured,
  isMasterAdminUser,
};
