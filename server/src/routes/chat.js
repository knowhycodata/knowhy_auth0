const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditLog');
const { query } = require('../db');
const sanitizeHtml = require('sanitize-html');
const { processMessage } = require('../services/workerAgent');
const { hasGoogleConnection } = require('../services/tokenVault');
const { buildStepUpContextFromClaims } = require('../services/stepUpContext');
const { verifyStepUpToken } = require('../services/stepUpTokenVerifier');

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

// POST /api/chat - Send a message to the AI agent
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      message,
      conversationId,
      locale,
      stepUpChallengeId,
      stepUpToken,
    } = req.body;

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
        [req.dbUser.id, sanitizedMessage.substring(0, 100), locale || req.dbUser.locale || 'en']
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

    // Save user message
    await query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)`,
      [convId, 'user', sanitizedMessage]
    );

    await auditLog(req.dbUser.id, 'chat_message_sent', 'chat', { conversationId: convId }, req);

    // Konuşma geçmişini al (son 20 mesaj)
    const historyResult = await query(
      `SELECT role, content FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 20`,
      [convId]
    );
    // Son mesajı (şu anda eklenen user mesajını) çıkar, çünkü worker'a ayrıca gönderiyoruz
    const conversationHistory = historyResult.rows.slice(0, -1);

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

    // Worker Agent + Guardrail Agent ile mesaji isle
    let stepUpContext = buildStepUpContextFromClaims(
      req.user.stepUpClaims || {},
      stepUpChallengeId || null
    );

    const normalizedStepUpToken = typeof stepUpToken === 'string'
      ? stepUpToken.trim()
      : '';

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
      locale: locale || req.dbUser.locale || 'en',
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
