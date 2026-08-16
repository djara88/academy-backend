const express = require('express');
const authMiddleware = require('../middleware/auth');
const { requireSuperadmin } = require('../middleware/authorization');
const { requireSuperadminMfa } = require('../middleware/requireMfa');
const { getPresenceSnapshot } = require('../services/userPresence');

const router = express.Router();
router.use(authMiddleware, requireSuperadmin, requireSuperadminMfa);

router.get('/', (_req, res) => {
  res.json({ success: true, data: getPresenceSnapshot() });
});

module.exports = router;
