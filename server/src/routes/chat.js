const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditLog');
const { query } = require('../db');
const sanitizeHtml = require('sanitize-html');
const { processMessage } = require('../services/workerAgent');
const { hasGoogleConnection } = require('../services/tokenVault');
const {
  buildStepUpContextFromClaims,
  getStepUpChallenge,
  markStepUpChallengeVerified,
} = require('../services/stepUpContext');
const { verifyStepUpToken, resolveAuthTimestamp } = require('../services/stepUpTokenVerifier');
const { executeTool } = require('../services/toolExecutor');

const STEP_UP_ALLOWED_ACTIONS = new Set(['send_email', 'delete_email', 'delete_latest_email']);
const STEP_UP_CHALLENGE_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP_UP_REQUIRE_MFA_CLAIM = process.env.STEP_UP_REQUIRE_MFA_CLAIM === 'true';
const STEP_UP_WINDOW_SECONDS = Number(process.env.STEP_UP_WINDOW_SECONDS || 300);

function sanitizeStepUpRequest(stepUpRequest) {
  if (!stepUpRequest || stepUpRequest.required !== true) return null;

  const action = String(stepUpRequest.action || '').trim().toLowerCase();
  if (!STEP_UP_ALLOWED_ACTIONS.has(action)) return null;

  const challengeId = String(stepUpRequest.challengeId || '').trim();
  if (!STEP_UP_CHALLENGE_ID_REGEX.test(challengeId)) return null;

  const expiresAt = Number(stepUpRequest.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

  const message = typeof stepUpRequest.message === 'string'
    ? stepUpRequest.message.slice(0, 600)
    : '';

  return {
    required: true,
    action,
    challengeId,
    expiresAt: Math.floor(expiresAt),
    message,
  };
}

function buildStepUpContextFromVerifiedToken(verification, challengeId) {
  if (verification?.valid) {
    const claims = verification.claims || {};
    return buildStepUpContextFromClaims(
      {
        amr: Array.isArray(claims.amr) ? claims.amr : [],
        acr: typeof claims.acr === 'string' ? claims.acr : null,
        authTime: Number.isFinite(Number(claims.auth_time)) ? Number(claims.auth_time) : null,
        issuedAt: Number.isFinite(Number(claims.iat)) ? Number(claims.iat) : null,
      },
      challengeId || null
    );
  }

  return {
    approved: false,
    reason: verification?.reason || 'stepup_token_invalid',
    hasRecentAuth: false,
    mfaDetected: false,
    authAgeSeconds: verification?.authAgeSeconds ?? null,
    authTimestamp: null,
    authTime: null,
    issuedAt: null,
    challengeId: challengeId || null,
    windowSeconds: STEP_UP_WINDOW_SECONDS,
    requireMfaClaim: STEP_UP_REQUIRE_MFA_CLAIM,
  };
}

function buildStepUpRequiredMessage(action, locale) {
  const trMap = {
    send_email: 'E-posta göndermek',
    delete_email: 'E-postayı silmek',
    delete_latest_email: 'Son gelen e-postayı silmek',
  };
  const enMap = {
    send_email: 'Sending the email',
    delete_email: 'Deleting the email',
    delete_latest_email: 'Deleting the latest email',
  };

  if (locale === 'tr') {
    const actionText = trMap[action] || 'Bu işlemi tamamlamak';
    return `${actionText} için ek güvenlik onayı gerekiyor. Devam etmek için aşağıdaki "Onaylıyorum" butonuna basın; Auth0 MFA doğrulaması açılacak ve işlem otomatik sürdürülecek.`;
  }

  const actionText = enMap[action] || 'Completing this action';
  return `${actionText} requires additional security approval. Click "I Approve" below to open Auth0 MFA, then the action will continue automatically.`;
}

function buildStepUpContextFromConfirmedChallenge(challenge, challengeId) {
  const authTimestamp = Number(challenge?.verifiedAuthTimestamp || 0);
  const now = Math.floor(Date.now() / 1000);
  const authAgeSeconds = authTimestamp > 0
    ? Math.max(0, now - authTimestamp)
    : null;

  return {
    approved: true,
    reason: 'challenge_verified',
    hasRecentAuth: authAgeSeconds !== null && authAgeSeconds <= STEP_UP_WINDOW_SECONDS,
    mfaDetected: !!challenge?.verifiedMfaDetected,
    authAgeSeconds,
    authTimestamp: authTimestamp || null,
    authTime: authTimestamp || null,
    issuedAt: authTimestamp || null,
    challengeId: challengeId || challenge?.challengeId || null,
    windowSeconds: STEP_UP_WINDOW_SECONDS,
    requireMfaClaim: STEP_UP_REQUIRE_MFA_CLAIM,
  };
}

function buildResumedToolResponse(toolName, toolResult, locale) {
  const lang = locale === 'tr' ? 'tr' : 'en';

  if (toolResult?.requiresStepUp) {
    const action = String(toolResult.action || toolName || '').trim().toLowerCase();
    const message = buildStepUpRequiredMessage(action, lang);
    return {
      content: message,
      stepUpRequest: sanitizeStepUpRequest({
        required: true,
        action,
        challengeId: toolResult.stepUpChallengeId || null,
        expiresAt: toolResult.stepUpChallengeExpiresAt || null,
        message,
      }),
    };
  }

  if (!toolResult?.success) {
    const errorText = String(toolResult?.error || '').trim()
      || (lang === 'tr' ? 'İşlem tamamlanamadı.' : 'The action could not be completed.');
    return {
      content: lang === 'tr'
        ? `İşlem tamamlanamadı: ${errorText}`
        : `The action could not be completed: ${errorText}`,
      stepUpRequest: null,
    };
  }

  if (toolName === 'delete_latest_email') {
    const deletedEmail = toolResult.deletedEmail || {};
    if (lang === 'tr') {
      const details = [
        deletedEmail.from ? `Gönderen: ${deletedEmail.from}` : null,
        deletedEmail.subject ? `Konu: ${deletedEmail.subject}` : null,
      ].filter(Boolean);

      return {
        content: details.length > 0
          ? `Son gelen e-posta başarıyla silindi.\n\n${details.join('\n')}`
          : 'Son gelen e-posta başarıyla silindi.',
        stepUpRequest: null,
      };
    }

    const details = [
      deletedEmail.from ? `Sender: ${deletedEmail.from}` : null,
      deletedEmail.subject ? `Subject: ${deletedEmail.subject}` : null,
    ].filter(Boolean);

    return {
      content: details.length > 0
        ? `The latest email was deleted successfully.\n\n${details.join('\n')}`
        : 'The latest email was deleted successfully.',
      stepUpRequest: null,
    };
  }

  if (toolName === 'delete_email') {
    return {
      content: lang === 'tr'
        ? 'E-posta başarıyla silindi.'
        : 'The email was deleted successfully.',
      stepUpRequest: null,
    };
  }

  if (toolName === 'send_email') {
    return {
      content: lang === 'tr'
        ? 'E-posta başarıyla gönderildi.'
        : 'The email was sent successfully.',
      stepUpRequest: null,
    };
  }

  return {
    content: lang === 'tr'
      ? 'İşlem başarıyla tamamlandı.'
      : 'The action completed successfully.',
    stepUpRequest: null,
  };
}

// POST /api/chat - Send a message to the AI agent
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      message,
      conversationId,
      locale,
      stepUpChallengeId,
      stepUpToken,
      stepUpResume,
    } = req.body;
    const activeLocale = locale || req.dbUser.locale || 'en';

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: req.t ? req.t('errors.emptyMessage') : 'Message cannot be empty',
      });
    }

    // Sanitize user input
    const sanitizedMessage = sanitizeHtml(message.trim(), {
      allowedTags: [],
      allowedAttributes: {},
    });

    if (sanitizedMessage.length > 5000) {
      return res.status(400).json({
        success: false,
        error: req.t ? req.t('errors.messageTooLong') : 'Message too long (max 5000 chars)',
      });
    }

    // Create or get conversation
    let convId = conversationId;
    if (!convId) {
      const convResult = await query(
        `INSERT INTO conversations (user_id, title, locale) VALUES ($1, $2, $3) RETURNING id`,
        [req.dbUser.id, sanitizedMessage.substring(0, 100), activeLocale]
      );
      convId = convResult.rows[0].id;
    } else {
      // Verify conversation belongs to user
      const convCheck = await query(
        'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
        [convId, req.dbUser.id]
      );
      if (convCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Conversation not found' });
      }
    }

    const normalizedStepUpToken = typeof stepUpToken === 'string'
      ? stepUpToken.trim()
      : '';
    let confirmedStepUpChallenge = getStepUpChallenge(stepUpChallengeId || null, req.user.sub);

    if (normalizedStepUpToken && stepUpChallengeId) {
      const stepUpVerification = await verifyStepUpToken(normalizedStepUpToken, {
        expectedUserSub: req.user.sub,
      });

      if (stepUpVerification.valid) {
        const confirmationResult = markStepUpChallengeVerified({
          challengeId: stepUpChallengeId,
          userId: req.user.sub,
          authTimestamp: resolveAuthTimestamp(stepUpVerification.claims || {}),
          mfaDetected: stepUpVerification.mfaDetected,
        });

        if (confirmationResult.approved) {
          confirmedStepUpChallenge = confirmationResult.entry;
        } else {
          logger.warn('Chat step-up challenge confirmation failed', {
            userSub: req.user.sub,
            challengeId: stepUpChallengeId,
            reason: confirmationResult.reason,
          });
        }
      } else {
        logger.warn('Chat step-up token verification failed', {
          userSub: req.user.sub,
          reason: stepUpVerification.reason,
        });
      }
    }

    const shouldPersistUserMessage = stepUpResume !== true;

    if (shouldPersistUserMessage) {
      await query(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
        [convId, 'user', sanitizedMessage]
      );

      await auditLog(req.dbUser.id, 'chat_message_sent', 'chat', { conversationId: convId }, req);
    }

    // Token Vault'tan gerçek Gmail bağlantı durumunu al ve DB ile senkronize et.
    let gmailConnected = req.dbUser.gmail_connected;
    try {
      const vaultConnected = await hasGoogleConnection(req.user.sub);
      gmailConnected = vaultConnected;

      if (vaultConnected !== req.dbUser.gmail_connected) {
        await query(
          'UPDATE users SET gmail_connected = $1, updated_at = NOW() WHERE id = $2',
          [vaultConnected, req.dbUser.id]
        );
      }
    } catch (vaultError) {
      logger.warn('Token Vault status check failed on chat route:', {
        error: vaultError.message,
        userSub: req.user.sub,
      });
    }

    const canResumeConfirmedStepUp = stepUpResume === true
      && !!confirmedStepUpChallenge
      && STEP_UP_ALLOWED_ACTIONS.has(confirmedStepUpChallenge.action)
      && Number.isFinite(Number(confirmedStepUpChallenge.verifiedAuthTimestamp))
      && Number(confirmedStepUpChallenge.verifiedAuthTimestamp) > 0;

    if (canResumeConfirmedStepUp) {
      const resumedToolResult = await executeTool(
        confirmedStepUpChallenge.action,
        confirmedStepUpChallenge.pendingArgs || {},
        {
          auth0UserId: req.user.sub,
          dbUserId: req.dbUser.id,
          userEmail: req.user.email,
          gmailConnected,
          locale: activeLocale,
          stepUpContext: buildStepUpContextFromConfirmedChallenge(
            confirmedStepUpChallenge,
            stepUpChallengeId || confirmedStepUpChallenge.challengeId
          ),
          req,
        }
      );

      const resumedPayload = buildResumedToolResponse(
        confirmedStepUpChallenge.action,
        resumedToolResult,
        activeLocale
      );
      const resumedStepUpRequest = sanitizeStepUpRequest(resumedPayload.stepUpRequest);
      const resumedMetadata = {
        resumedStepUp: true,
        resumedAction: confirmedStepUpChallenge.action,
        toolResults: [{
          tool: confirmedStepUpChallenge.action,
          success: resumedToolResult?.success,
          requiresStepUp: !!resumedToolResult?.requiresStepUp,
          action: resumedToolResult?.action || confirmedStepUpChallenge.action,
        }],
      };

      if (resumedStepUpRequest) {
        resumedMetadata.stepUpRequest = resumedStepUpRequest;
      }

      await query(
        `INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4)`,
        [
          convId,
          'assistant',
          resumedPayload.content,
          JSON.stringify(resumedMetadata),
        ]
      );

      await query(
        'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
        [convId]
      );

      return res.json({
        success: true,
        conversationId: convId,
        message: {
          role: 'assistant',
          content: resumedPayload.content,
          ...(resumedStepUpRequest && { stepUpRequest: resumedStepUpRequest }),
        },
        ...(resumedStepUpRequest && { stepUpRequest: resumedStepUpRequest }),
      });
    }

    // Konuşma geçmişini al (son 20 mesaj)
    const historyResult = await query(
      `SELECT role, content FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 20`,
      [convId]
    );
    const conversationHistory = shouldPersistUserMessage
      ? historyResult.rows.slice(0, -1)
      : historyResult.rows;

    // Worker Agent + Guardrail Agent ile mesaji isle
    let stepUpContext = buildStepUpContextFromClaims(
      req.user.stepUpClaims || {},
      stepUpChallengeId || null
    );

    if (normalizedStepUpToken) {
      const stepUpVerification = await verifyStepUpToken(normalizedStepUpToken, {
        expectedUserSub: req.user.sub,
      });
      stepUpContext = buildStepUpContextFromVerifiedToken(
        stepUpVerification,
        stepUpChallengeId || null
      );

      if (!stepUpVerification.valid) {
        logger.warn('Chat step-up token verification failed', {
          userSub: req.user.sub,
          reason: stepUpVerification.reason,
        });
      }
    }

    const agentResult = await processMessage(sanitizedMessage, conversationHistory, {
      auth0UserId: req.user.sub,
      dbUserId: req.dbUser.id,
      userEmail: req.user.email,
      gmailConnected,
      locale: activeLocale,
      stepUpContext,
      req,
    });

    const assistantResponse = agentResult.content;
    const stepUpRequest = sanitizeStepUpRequest(agentResult.stepUpRequest);

    // Save assistant response with metadata
    const metadata = {};
    if (agentResult.toolResults.length > 0) {
      metadata.toolResults = agentResult.toolResults.map((tr) => ({
        tool: tr.tool,
        success: tr.result?.success,
        requiresStepUp: !!tr.result?.requiresStepUp,
        action: tr.result?.action || null,
      }));
    }
    if (agentResult.guardrailFlags.length > 0) {
      metadata.guardrailFlags = agentResult.guardrailFlags;
    }
    if (stepUpRequest) {
      metadata.stepUpRequest = stepUpRequest;
    }

    await query(
      `INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4)`,
      [convId, 'assistant', assistantResponse, Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null]
    );

    // Update conversation timestamp
    await query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
      [convId]
    );

    res.json({
      success: true,
      conversationId: convId,
      message: {
        role: 'assistant',
        content: assistantResponse,
        ...(stepUpRequest && { stepUpRequest }),
      },
      ...(agentResult.guardrailFlags.length > 0 && { guardrailFlags: agentResult.guardrailFlags }),
      ...(stepUpRequest && { stepUpRequest }),
    });
  } catch (error) {
    logger.error('Chat error:', error);
    res.status(500).json({
      success: false,
      error: req.t ? req.t('errors.chatFailed') : 'Failed to process message',
    });
  }
});

// GET /api/chat/conversations - List conversations (alias)
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.title, c.locale, c.created_at, c.updated_at,
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
       FROM conversations c
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC
       LIMIT 50`,
      [req.dbUser.id]
    );

    res.json({ success: true, conversations: result.rows });
  } catch (error) {
    logger.error('Conversations fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch conversations' });
  }
});

module.exports = router;
