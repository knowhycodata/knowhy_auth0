const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditLog');
const { initiateStepUp, checkStepUpStatus } = require('../services/stepUpAuth');

// POST /api/auth/stepup/initiate - Start a step-up auth request (CIBA)
router.post('/initiate', requireAuth, async (req, res) => {
  try {
    const { action, bindingMessage } = req.body;

    if (!action) {
      return res.status(400).json({ success: false, error: 'action is required' });
    }

    const defaultMessages = {
      send_email: 'Knowhy: Approve email send action',
      delete_email: 'Knowhy: Approve email delete action',
    };

    const message = bindingMessage || defaultMessages[action] || `Knowhy: Approve ${action}`;

    const result = await initiateStepUp(req.user.sub, message);

    await auditLog(req.dbUser.id, 'stepup_initiated', 'auth', {
      action,
      authReqId: result.authReqId,
    }, req);

    res.json({
      success: true,
      authReqId: result.authReqId,
      expiresIn: result.expiresIn,
      interval: result.interval,
    });
  } catch (error) {
    logger.error('Step-up initiation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to initiate step-up authentication',
    });
  }
});

// POST /api/auth/stepup/poll - Poll step-up auth status
router.post('/poll', requireAuth, async (req, res) => {
  try {
    const { authReqId } = req.body;

    if (!authReqId) {
      return res.status(400).json({ success: false, error: 'authReqId is required' });
    }

    const result = await checkStepUpStatus(authReqId);

    if (result.status === 'approved') {
      await auditLog(req.dbUser.id, 'stepup_approved', 'auth', { authReqId }, req);
    } else if (result.status === 'rejected') {
      await auditLog(req.dbUser.id, 'stepup_rejected', 'auth', { authReqId }, req);
    }

    res.json({
      success: true,
      status: result.status,
      ...(result.status === 'approved' && { stepUpToken: result.accessToken }),
    });
  } catch (error) {
    logger.error('Step-up poll error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check step-up status',
    });
  }
});

module.exports = router;
