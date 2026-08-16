const express = require('express');
const authMiddleware = require('../middleware/auth');
const { recordUserPresence } = require('../services/userPresence');

const router = express.Router();

router.post('/heartbeat', authMiddleware, (req, res) => {
  recordUserPresence(req.user);
  res.status(204).end();
});

module.exports = router;
