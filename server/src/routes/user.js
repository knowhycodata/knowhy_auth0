const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { query } = require('../db');

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

    res.json({ success: true, messages: messages.rows });
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
