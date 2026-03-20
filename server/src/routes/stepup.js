const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditLog');
const { initiateStepUp, checkStepUpStatus } = require('../services/stepUpAuth');
const { verifyStepUpToken, resolveAuthTimestamp } = require('../services/stepUpTokenVerifier');
const { markStepUpChallengeVerified } = require('../services/stepUpContext');

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
      ...(result.status === 'approved' && {
        stepUpToken: result.idToken || result.accessToken,
        stepUpIdToken: result.idToken || null,
        stepUpAccessToken: result.accessToken || null,
      }),
    });
  } catch (error) {
    logger.error('Step-up poll error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to check step-up status',
    });
  }
});

// POST /api/auth/stepup/confirm - Verify popup token and bind it to a pending challenge
router.post('/confirm', requireAuth, async (req, res) => {
  try {
    const challengeId = String(req.body?.challengeId || '').trim();
    const stepUpToken = String(req.body?.stepUpToken || '').trim();

    if (!challengeId) {
      return res.status(400).json({ success: false, error: 'challengeId is required' });
    }

    if (!stepUpToken) {
      return res.status(400).json({ success: false, error: 'stepUpToken is required' });
    }

    // skipFreshnessCheck: Frontend mevcut ID token ile inline confirm yapıyor.
    // Auth0'ya redirect/popup yapılmaz — bu Gmail scope'larını korur.
    // Token imza doğrulaması + user sub eşleşmesi yeterli kabul edilir.
    const verification = await verifyStepUpToken(stepUpToken, {
      expectedUserSub: req.user.sub,
      skipFreshnessCheck: true,
    });

    if (!verification.valid) {
      await auditLog(req.dbUser.id, 'stepup_confirm_rejected', 'auth', {
        challengeId,
        reason: verification.reason,
      }, req, 'rejected');

      return res.status(403).json({
        success: false,
        error: 'Step-up verification is invalid or expired',
        reason: verification.reason,
      });
    }

    const isInlineConfirm = verification.reason === 'verified_inline';
    const challengeResult = markStepUpChallengeVerified({
      challengeId,
      userId: req.user.sub,
      authTimestamp: resolveAuthTimestamp(verification.claims || {}),
      mfaDetected: verification.mfaDetected,
      skipTimestampCheck: isInlineConfirm,
    });

    if (!challengeResult.approved) {
      await auditLog(req.dbUser.id, 'stepup_confirm_rejected', 'auth', {
        challengeId,
        reason: challengeResult.reason,
      }, req, 'rejected');

      return res.status(403).json({
        success: false,
        error: 'Step-up challenge confirmation failed',
        reason: challengeResult.reason,
      });
    }

    await auditLog(req.dbUser.id, 'stepup_confirmed', 'auth', {
      challengeId,
      action: challengeResult.entry?.action || null,
      authTimestamp: challengeResult.entry?.verifiedAuthTimestamp || null,
      mfaDetected: challengeResult.entry?.verifiedMfaDetected || false,
    }, req, 'approved');

    res.json({
      success: true,
      challengeId,
      action: challengeResult.entry?.action || null,
      expiresAt: challengeResult.entry?.expiresAt || null,
    });
  } catch (error) {
    logger.error('Step-up confirm error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to confirm step-up authentication',
    });
  }
});

module.exports = router;
