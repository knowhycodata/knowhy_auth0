const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../db');

const STEP_UP_ALLOWED_ACTIONS = new Set(['send_email', 'delete_email', 'delete_latest_email']);
const STEP_UP_CHALLENGE_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function sanitizeMessageMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;

  const safeMetadata = {};

  if (Array.isArray(metadata.toolResults)) {
    safeMetadata.toolResults = metadata.toolResults.map((item) => ({
      tool: String(item?.tool || ''),
      success: !!item?.success,
      requiresStepUp: !!item?.requiresStepUp,
      action: item?.action ? String(item.action) : null,
    }));
  }

  if (Array.isArray(metadata.guardrailFlags)) {
    safeMetadata.guardrailFlags = metadata.guardrailFlags.map((item) => ({
      type: String(item?.type || ''),
      tool: item?.tool ? String(item.tool) : null,
      reason: item?.reason ? String(item.reason).slice(0, 300) : null,
    }));
  }

  const stepUpRequest = sanitizeStepUpRequest(metadata.stepUpRequest);
  if (stepUpRequest) {
    safeMetadata.stepUpRequest = stepUpRequest;
  }

  return Object.keys(safeMetadata).length > 0 ? safeMetadata : null;
}

function parseMetadata(metadata) {
  if (!metadata) return null;
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  if (typeof metadata === 'object') return metadata;
  return null;
}

// GET /api/user/conversations - List user conversations
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, title, locale, created_at, updated_at
       FROM conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [req.dbUser.id]
    );

    res.json({ success: true, conversations: result.rows });
  } catch (error) {
    logger.error('Conversations fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch conversations' });
  }
});

// GET /api/user/conversations/:id/messages - Get conversation messages
router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify conversation belongs to user
    const convResult = await query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [id, req.dbUser.id]
    );

    if (convResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    const messages = await query(
      `SELECT id, role, content, tool_calls, metadata, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id]
    );

    const sanitizedMessages = messages.rows.map((msg) => {
      const parsedMetadata = parseMetadata(msg.metadata);
      const metadata = sanitizeMessageMetadata(parsedMetadata);
      const stepUpRequest = sanitizeStepUpRequest(parsedMetadata?.stepUpRequest);

      return {
        ...msg,
        metadata,
        ...(stepUpRequest && { stepUpRequest }),
      };
    });

    res.json({ success: true, messages: sanitizedMessages });
  } catch (error) {
    logger.error('Messages fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

// DELETE /api/user/conversations/:id - Delete a conversation
router.delete('/conversations/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.dbUser.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    res.json({ success: true, message: 'Conversation deleted' });
  } catch (error) {
    logger.error('Conversation delete error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete conversation' });
  }
});

// GET /api/user/email-summaries - Get email summaries
router.get('/email-summaries', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, summary_date, summary_text, email_count, locale, created_at
       FROM email_summaries
       WHERE user_id = $1
       ORDER BY summary_date DESC
       LIMIT 30`,
      [req.dbUser.id]
    );

    res.json({ success: true, summaries: result.rows });
  } catch (error) {
    logger.error('Email summaries fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch summaries' });
  }
});

module.exports = router;
