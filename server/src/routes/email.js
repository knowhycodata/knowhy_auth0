const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditLog');
const gmailService = require('../services/gmail');
const { hasGoogleConnection } = require('../services/tokenVault');
const { verifyStepUpToken } = require('../services/stepUpTokenVerifier');

function buildStepUpFailureResponse(req, action, stepUpReason) {
  return {
    success: false,
    requiresStepUp: true,
    action,
    stepUpReason,
    message: req.t
      ? req.t('email.stepUpInvalid')
      : 'Step-up verification is invalid or expired. Please approve MFA and try again.',
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

    const { to, subject, body, cc, bcc, inReplyTo, threadId, stepUpToken } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({
        success: false,
        error: 'to, subject, and body are required',
      });
    }

    // HIGH-STAKES ACTION: Step-up Auth kontrolü
    // stepUpToken yoksa, kullanıcıdan MFA onayı iste
    if (!stepUpToken) {
      await auditLog(req.dbUser.id, 'email_send_stepup_required', 'gmail', { to, subject }, req);

      return res.json({
        success: true,
        requiresStepUp: true,
        action: 'send_email',
        message: req.t
          ? req.t('email.stepUpRequired')
          : 'Sending emails requires additional authentication (MFA). Please approve the request.',
      });
    }

    const stepUpVerification = await verifyStepUpToken(stepUpToken, {
      expectedUserSub: req.user.sub,
    });

    if (!stepUpVerification.valid) {
      await auditLog(req.dbUser.id, 'email_send_stepup_rejected', 'gmail', {
        to,
        subject,
        stepUpReason: stepUpVerification.reason,
      }, req, 'rejected');

      return res.status(403).json(
        buildStepUpFailureResponse(req, 'send_email', stepUpVerification.reason)
      );
    }

    await auditLog(req.dbUser.id, 'email_send_stepup_verified', 'gmail', {
      to,
      subject,
      stepUpReason: stepUpVerification.reason,
      authAgeSeconds: stepUpVerification.authAgeSeconds,
      mfaDetected: stepUpVerification.mfaDetected,
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

    const { emailId, stepUpToken } = req.body;

    if (!emailId) {
      return res.status(400).json({ success: false, error: 'emailId is required' });
    }

    // HIGH-STAKES ACTION: Step-up Auth kontrolü
    if (!stepUpToken) {
      await auditLog(req.dbUser.id, 'email_delete_stepup_required', 'gmail', { emailId }, req);

      return res.json({
        success: true,
        requiresStepUp: true,
        action: 'delete_email',
        message: req.t
          ? req.t('email.stepUpRequired')
          : 'Deleting emails requires additional authentication (MFA). Please approve the request.',
      });
    }

    const stepUpVerification = await verifyStepUpToken(stepUpToken, {
      expectedUserSub: req.user.sub,
    });

    if (!stepUpVerification.valid) {
      await auditLog(req.dbUser.id, 'email_delete_stepup_rejected', 'gmail', {
        emailId,
        stepUpReason: stepUpVerification.reason,
      }, req, 'rejected');

      return res.status(403).json(
        buildStepUpFailureResponse(req, 'delete_email', stepUpVerification.reason)
      );
    }

    await auditLog(req.dbUser.id, 'email_delete_stepup_verified', 'gmail', {
      emailId,
      stepUpReason: stepUpVerification.reason,
      authAgeSeconds: stepUpVerification.authAgeSeconds,
      mfaDetected: stepUpVerification.mfaDetected,
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
