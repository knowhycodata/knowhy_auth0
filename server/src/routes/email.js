const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditLog');
const gmailService = require('../services/gmail');
const { hasGoogleConnection } = require('../services/tokenVault');
const { verifyStepUpToken, resolveAuthTimestamp } = require('../services/stepUpTokenVerifier');
const { createStepUpChallenge, getStepUpChallenge, consumeStepUpChallenge } = require('../services/stepUpContext');

function buildStepUpFailureResponse(req, action, stepUpReason, challenge = null) {
  return {
    success: false,
    requiresStepUp: true,
    action,
    stepUpReason,
    stepUpChallengeId: challenge?.challengeId || null,
    stepUpChallengeExpiresAt: challenge?.expiresAt || null,
    message: req.t
      ? req.t('email.stepUpInvalid')
      : 'Step-up verification is invalid or expired. Please approve MFA and try again.',
  };
}

function getOrCreateActionChallenge({ userId, action, pendingArgs, stepUpChallengeId }) {
  const normalizedChallengeId = typeof stepUpChallengeId === 'string'
    ? stepUpChallengeId.trim()
    : '';
  const existingChallenge = normalizedChallengeId
    ? getStepUpChallenge(normalizedChallengeId, userId)
    : null;

  if (existingChallenge && existingChallenge.action === action) {
    return existingChallenge;
  }

  return createStepUpChallenge({
    userId,
    action,
    pendingArgs,
  });
}

function buildStepUpRequiredResponse(req, action, challenge) {
  const defaultMessage = action === 'send_email'
    ? 'Sending emails requires additional authentication (MFA). Please approve the request.'
    : 'Deleting emails requires additional authentication (MFA). Please approve the request.';

  return {
    success: true,
    requiresStepUp: true,
    action,
    stepUpChallengeId: challenge.challengeId,
    stepUpChallengeExpiresAt: challenge.expiresAt,
    message: req.t ? req.t('email.stepUpRequired') : defaultMessage,
  };
}

// GET /api/email/status - Check Gmail connection status
router.get('/status', requireAuth, async (req, res) => {
  try {
    // Token Vault'tan gerçek bağlantı durumunu kontrol et
    let vaultConnected = false;
    try {
      vaultConnected = await hasGoogleConnection(req.user.sub);
    } catch {
      // Token Vault erişilemezse DB değerine düş
      vaultConnected = req.dbUser.gmail_connected;
    }

    res.json({
      success: true,
      gmailConnected: vaultConnected,
      message: vaultConnected
        ? (req.t ? req.t('email.connected') : 'Gmail is connected')
        : (req.t ? req.t('email.notConnected') : 'Gmail is not connected'),
    });
  } catch (error) {
    logger.error('Email status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check email status' });
  }
});

// POST /api/email/read - Read emails via Token Vault (Blind Token Injection)
// LLM hiçbir zaman token'ı görmez. Backend "uzaktan kol" olarak çalışır.
router.post('/read', requireAuth, async (req, res) => {
  try {
    if (!req.dbUser.gmail_connected) {
      return res.status(403).json({
        success: false,
        error: req.t ? req.t('email.connectFirst') : 'Please connect Gmail first',
      });
    }

    const { maxResults = 10, query: searchQuery = '', labelIds } = req.body;

    await auditLog(req.dbUser.id, 'email_read', 'gmail', { maxResults, searchQuery }, req);

    // BLIND TOKEN INJECTION: Token sadece backend servisinde yaşar
    const result = await gmailService.listEmails(req.user.sub, {
      maxResults: Math.min(maxResults, 20),
      query: searchQuery,
      labelIds: labelIds || ['INBOX'],
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Email read error:', error);
    res.status(500).json({ success: false, error: 'Failed to read emails' });
  }
});

// POST /api/email/detail - Get a single email's full body
router.post('/detail', requireAuth, async (req, res) => {
  try {
    if (!req.dbUser.gmail_connected) {
      return res.status(403).json({
        success: false,
        error: req.t ? req.t('email.connectFirst') : 'Please connect Gmail first',
      });
    }

    const { messageId } = req.body;
    if (!messageId) {
      return res.status(400).json({ success: false, error: 'messageId is required' });
    }

    await auditLog(req.dbUser.id, 'email_detail_read', 'gmail', { messageId }, req);

    const result = await gmailService.getEmailBody(req.user.sub, messageId);

    res.json({ success: true, email: result });
  } catch (error) {
    logger.error('Email detail error:', error);
    res.status(500).json({ success: false, error: 'Failed to read email detail' });
  }
});

// POST /api/email/send - Send email (HIGH-STAKES: requires Step-up Auth / MFA)
router.post('/send', requireAuth, async (req, res) => {
  try {
    if (!req.dbUser.gmail_connected) {
      return res.status(403).json({
        success: false,
        error: req.t ? req.t('email.connectFirst') : 'Please connect Gmail first',
      });
    }

    const {
      to,
      subject,
      body,
      cc,
      bcc,
      inReplyTo,
      threadId,
      stepUpToken,
      stepUpChallengeId,
    } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({
        success: false,
        error: 'to, subject, and body are required',
      });
    }

    const challenge = getOrCreateActionChallenge({
      userId: req.user.sub,
      action: 'send_email',
      pendingArgs: { to, subject, body, cc, bcc, inReplyTo, threadId },
      stepUpChallengeId,
    });
    const normalizedStepUpToken = typeof stepUpToken === 'string'
      ? stepUpToken.trim()
      : '';

    // HIGH-STAKES ACTION: token + challenge birlikte zorunlu
    if (!normalizedStepUpToken) {
      await auditLog(req.dbUser.id, 'email_send_stepup_required', 'gmail', {
        to,
        subject,
        challengeId: challenge.challengeId,
      }, req);

      return res.json(buildStepUpRequiredResponse(req, 'send_email', challenge));
    }

    const stepUpVerification = await verifyStepUpToken(normalizedStepUpToken, {
      expectedUserSub: req.user.sub,
    });

    if (!stepUpVerification.valid) {
      await auditLog(req.dbUser.id, 'email_send_stepup_rejected', 'gmail', {
        to,
        subject,
        stepUpReason: stepUpVerification.reason,
        challengeId: challenge.challengeId,
      }, req, 'rejected');

      return res.status(403).json(
        buildStepUpFailureResponse(req, 'send_email', stepUpVerification.reason, challenge)
      );
    }

    const challengeVerification = consumeStepUpChallenge({
      challengeId: challenge.challengeId,
      userId: req.user.sub,
      action: 'send_email',
      authTimestamp: resolveAuthTimestamp(stepUpVerification.claims || {}),
      mfaDetected: stepUpVerification.mfaDetected,
    });

    if (!challengeVerification.approved) {
      await auditLog(req.dbUser.id, 'email_send_stepup_rejected', 'gmail', {
        to,
        subject,
        stepUpReason: challengeVerification.reason,
        challengeId: challenge.challengeId,
      }, req, 'rejected');

      return res.status(403).json(
        buildStepUpFailureResponse(req, 'send_email', challengeVerification.reason, challenge)
      );
    }

    await auditLog(req.dbUser.id, 'email_send_stepup_verified', 'gmail', {
      to,
      subject,
      stepUpReason: stepUpVerification.reason,
      authAgeSeconds: stepUpVerification.authAgeSeconds,
      mfaDetected: stepUpVerification.mfaDetected,
      challengeId: challenge.challengeId,
    }, req, 'approved');

    await auditLog(req.dbUser.id, 'email_sent', 'gmail', { to, subject }, req);

    const result = await gmailService.sendEmail(req.user.sub, {
      to, subject, body, cc, bcc, inReplyTo, threadId,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Email send error:', error);
    res.status(500).json({ success: false, error: 'Failed to send email' });
  }
});

// POST /api/email/delete - Delete email (HIGH-STAKES: requires Step-up Auth / MFA)
router.post('/delete', requireAuth, async (req, res) => {
  try {
    if (!req.dbUser.gmail_connected) {
      return res.status(403).json({
        success: false,
        error: req.t ? req.t('email.connectFirst') : 'Please connect Gmail first',
      });
    }

    const { emailId, stepUpToken, stepUpChallengeId } = req.body;

    if (!emailId) {
      return res.status(400).json({ success: false, error: 'emailId is required' });
    }

    const challenge = getOrCreateActionChallenge({
      userId: req.user.sub,
      action: 'delete_email',
      pendingArgs: { emailId },
      stepUpChallengeId,
    });
    const normalizedStepUpToken = typeof stepUpToken === 'string'
      ? stepUpToken.trim()
      : '';

    // HIGH-STAKES ACTION: token + challenge birlikte zorunlu
    if (!normalizedStepUpToken) {
      await auditLog(req.dbUser.id, 'email_delete_stepup_required', 'gmail', {
        emailId,
        challengeId: challenge.challengeId,
      }, req);

      return res.json(buildStepUpRequiredResponse(req, 'delete_email', challenge));
    }

    const stepUpVerification = await verifyStepUpToken(normalizedStepUpToken, {
      expectedUserSub: req.user.sub,
    });

    if (!stepUpVerification.valid) {
      await auditLog(req.dbUser.id, 'email_delete_stepup_rejected', 'gmail', {
        emailId,
        stepUpReason: stepUpVerification.reason,
        challengeId: challenge.challengeId,
      }, req, 'rejected');

      return res.status(403).json(
        buildStepUpFailureResponse(req, 'delete_email', stepUpVerification.reason, challenge)
      );
    }

    const challengeVerification = consumeStepUpChallenge({
      challengeId: challenge.challengeId,
      userId: req.user.sub,
      action: 'delete_email',
      authTimestamp: resolveAuthTimestamp(stepUpVerification.claims || {}),
      mfaDetected: stepUpVerification.mfaDetected,
    });

    if (!challengeVerification.approved) {
      await auditLog(req.dbUser.id, 'email_delete_stepup_rejected', 'gmail', {
        emailId,
        stepUpReason: challengeVerification.reason,
        challengeId: challenge.challengeId,
      }, req, 'rejected');

      return res.status(403).json(
        buildStepUpFailureResponse(req, 'delete_email', challengeVerification.reason, challenge)
      );
    }

    await auditLog(req.dbUser.id, 'email_delete_stepup_verified', 'gmail', {
      emailId,
      stepUpReason: stepUpVerification.reason,
      authAgeSeconds: stepUpVerification.authAgeSeconds,
      mfaDetected: stepUpVerification.mfaDetected,
      challengeId: challenge.challengeId,
    }, req, 'approved');

    await auditLog(req.dbUser.id, 'email_deleted', 'gmail', { emailId }, req);

    const result = await gmailService.trashEmail(req.user.sub, emailId);

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('Email delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete email' });
  }
});

module.exports = router;
