const express = require('express');
const router = express.Router();
const axios = require('axios');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditLog');
const { query } = require('../db');
const { hasGoogleConnection } = require('../services/tokenVault');

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;

// GET /api/auth/profile - Get current user profile
router.get('/profile', requireAuth, async (req, res) => {
  try {
    let gmailConnected = req.dbUser.gmail_connected;

    // Token Vault'tan gerçek bağlantı durumunu kontrol et ve DB ile senkronize et.
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
      logger.warn('Token Vault status check failed on profile route:', {
        error: vaultError.message,
        userSub: req.user.sub,
      });
    }

    res.json({
      success: true,
      user: {
        id: req.dbUser.id,
        auth0Id: req.dbUser.auth0_id,
        email: req.dbUser.email,
        name: req.dbUser.name,
        picture: req.dbUser.picture,
        locale: req.dbUser.locale,
        gmailConnected,
      },
    });
  } catch (error) {
    logger.error('Profile fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

// PUT /api/auth/locale - Update user locale
router.put('/locale', requireAuth, async (req, res) => {
  try {
    const { locale } = req.body;
    if (!['tr', 'en'].includes(locale)) {
      return res.status(400).json({ success: false, error: 'Invalid locale. Supported: tr, en' });
    }

    await query('UPDATE users SET locale = $1, updated_at = NOW() WHERE id = $2', [locale, req.dbUser.id]);

    res.json({ success: true, locale });
  } catch (error) {
    logger.error('Locale update error:', error);
    res.status(500).json({ success: false, error: 'Failed to update locale' });
  }
});

// POST /api/auth/connect-gmail - Initiate Gmail connection via Auth0 Token Vault
router.post('/connect-gmail', requireAuth, async (req, res) => {
  try {
    // Gmail OAuth callback'i frontend'e döner; Settings sayfası profile endpoint'inden
    // Token Vault durumunu okuyarak bağlantı bilgisini günceller.
    const gmailCallbackUrl = process.env.AUTH0_GMAIL_CALLBACK_URL
      || (process.env.CLIENT_URL || 'http://localhost:5173');

    // This endpoint returns the Auth0 authorization URL for Google connection
    // The actual token is stored in Auth0 Token Vault, never in our DB
    const oidcScope = 'openid profile email';
    const googleConnectionScope = 'https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send';

    const connectionUrl = `https://${AUTH0_DOMAIN}/authorize?` +
      `response_type=code&` +
      `client_id=${AUTH0_CLIENT_ID}&` +
      `connection=google-oauth2&` +
      `scope=${encodeURIComponent(oidcScope)}&` +
      `connection_scope=${encodeURIComponent(googleConnectionScope)}&` +
      `redirect_uri=${encodeURIComponent(gmailCallbackUrl)}&` +
      `access_type=offline&` +
      `prompt=consent&` +
      `include_granted_scopes=true`;

    await auditLog(req.dbUser.id, 'gmail_connect_initiated', 'gmail', null, req);

    res.json({
      success: true,
      connectionUrl,
      message: req.t ? req.t('auth.gmailConnectPrompt') : 'Please authorize Gmail access',
    });
  } catch (error) {
    logger.error('Gmail connect error:', error);
    res.status(500).json({ success: false, error: 'Failed to initiate Gmail connection' });
  }
});

// POST /api/auth/gmail-callback - Handle Gmail connection callback
router.post('/gmail-callback', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE users SET gmail_connected = TRUE, updated_at = NOW() WHERE id = $1',
      [req.dbUser.id]
    );

    await auditLog(req.dbUser.id, 'gmail_connected', 'gmail', null, req);

    res.json({
      success: true,
      message: req.t ? req.t('auth.gmailConnected') : 'Gmail connected successfully',
    });
  } catch (error) {
    logger.error('Gmail callback error:', error);
    res.status(500).json({ success: false, error: 'Failed to complete Gmail connection' });
  }
});

// POST /api/auth/disconnect-gmail - Disconnect Gmail
router.post('/disconnect-gmail', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE users SET gmail_connected = FALSE, updated_at = NOW() WHERE id = $1',
      [req.dbUser.id]
    );

    await auditLog(req.dbUser.id, 'gmail_disconnected', 'gmail', null, req);

    res.json({
      success: true,
      message: req.t ? req.t('auth.gmailDisconnected') : 'Gmail disconnected',
    });
  } catch (error) {
    logger.error('Gmail disconnect error:', error);
    res.status(500).json({ success: false, error: 'Failed to disconnect Gmail' });
  }
});

module.exports = router;
