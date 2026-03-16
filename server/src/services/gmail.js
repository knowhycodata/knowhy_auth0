const axios = require('axios');
const logger = require('../utils/logger');
const { getFederatedToken } = require('./tokenVault');

const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';

/**
 * BLIND TOKEN INJECTION: Bu servis LLM'e hiçbir token göstermez.
 * Backend "uzaktan kol" olarak Token Vault'tan token'ı çeker,
 * Gmail API'ye istek yapar ve LLM'e sadece sonucu döner.
 */

/**
 * Gmail API'ye istek yapmak için header oluştur.
 * Token sadece bu fonksiyon içinde yaşar, asla dışarı sızmaz.
 */
async function getGmailHeaders(auth0UserId) {
  const accessToken = await getFederatedToken(auth0UserId);
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Kullanıcının e-postalarını listele.
 * @param {string} auth0UserId
 * @param {object} options - { maxResults, query, labelIds }
 * @returns {object} - { emails: [...], resultSizeEstimate }
 */
async function listEmails(auth0UserId, options = {}) {
  try {
    const headers = await getGmailHeaders(auth0UserId);
    const { maxResults = 10, query = '', labelIds = ['INBOX'] } = options;

    const response = await axios.get(`${GMAIL_API_BASE}/messages`, {
      headers,
      params: {
        maxResults,
        q: query,
        labelIds: labelIds.join(','),
      },
    });

    if (!response.data.messages || response.data.messages.length === 0) {
      return { emails: [], resultSizeEstimate: 0 };
    }

    // Her e-posta için detay bilgisi al
    const emailPromises = response.data.messages.slice(0, maxResults).map(
      (msg) => getEmailDetail(auth0UserId, msg.id, headers)
    );

    const emails = await Promise.all(emailPromises);

    logger.info('Emails listed successfully', {
      userId: auth0UserId,
      count: emails.length,
    });

    // ÖNEMLI: Sadece güvenli metadata döndür, ham token bilgisi ASLA yer almaz
    return {
      emails: emails.filter(Boolean),
      resultSizeEstimate: response.data.resultSizeEstimate || emails.length,
    };
  } catch (error) {
    logger.error('Failed to list emails:', {
      userId: auth0UserId,
      error: error.response?.data || error.message,
    });
    throw new Error('Failed to list emails');
  }
}

/**
 * Tek bir e-postanın detayını al.
 */
async function getEmailDetail(auth0UserId, messageId, existingHeaders = null) {
  try {
    const headers = existingHeaders || await getGmailHeaders(auth0UserId);

    const response = await axios.get(`${GMAIL_API_BASE}/messages/${messageId}`, {
      headers,
      params: {
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date', 'Cc'],
      },
    });

    const headerMap = {};
    (response.data.payload?.headers || []).forEach((h) => {
      headerMap[h.name.toLowerCase()] = h.value;
    });

    return {
      id: response.data.id,
      threadId: response.data.threadId,
      snippet: response.data.snippet,
      subject: headerMap.subject || '(No subject)',
      from: headerMap.from || 'Unknown',
      to: headerMap.to || '',
      cc: headerMap.cc || '',
      date: headerMap.date || '',
      labelIds: response.data.labelIds || [],
      isUnread: (response.data.labelIds || []).includes('UNREAD'),
    };
  } catch (error) {
    logger.error('Failed to get email detail:', {
      messageId,
      error: error.response?.data || error.message,
    });
    return null;
  }
}

/**
 * E-postanın tam içeriğini al (body dahil).
 */
async function getEmailBody(auth0UserId, messageId) {
  try {
    const headers = await getGmailHeaders(auth0UserId);

    const response = await axios.get(`${GMAIL_API_BASE}/messages/${messageId}`, {
      headers,
      params: { format: 'full' },
    });

    const payload = response.data.payload;
    let body = '';

    if (payload.body?.data) {
      body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload.parts) {
      const textPart = payload.parts.find(
        (p) => p.mimeType === 'text/plain' && p.body?.data
      );
      const htmlPart = payload.parts.find(
        (p) => p.mimeType === 'text/html' && p.body?.data
      );

      const selectedPart = textPart || htmlPart;
      if (selectedPart?.body?.data) {
        body = Buffer.from(selectedPart.body.data, 'base64').toString('utf-8');
      }
    }

    return {
      id: messageId,
      body,
      snippet: response.data.snippet,
    };
  } catch (error) {
    logger.error('Failed to get email body:', {
      messageId,
      error: error.response?.data || error.message,
    });
    throw new Error('Failed to read email content');
  }
}

/**
 * E-posta gönder.
 * HIGH-STAKES ACTION: Step-up Auth gerektirir (Adım 5'te tam entegrasyon).
 */
async function sendEmail(auth0UserId, { to, subject, body, cc, bcc, inReplyTo, threadId }) {
  try {
    const headers = await getGmailHeaders(auth0UserId);

    // RFC 2822 formatında e-posta oluştur
    let rawEmail = '';
    rawEmail += `To: ${to}\r\n`;
    if (cc) rawEmail += `Cc: ${cc}\r\n`;
    if (bcc) rawEmail += `Bcc: ${bcc}\r\n`;
    rawEmail += `Subject: ${subject}\r\n`;
    if (inReplyTo) rawEmail += `In-Reply-To: ${inReplyTo}\r\n`;
    rawEmail += `Content-Type: text/plain; charset=utf-8\r\n`;
    rawEmail += `\r\n${body}`;

    const encodedEmail = Buffer.from(rawEmail)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const payload = { raw: encodedEmail };
    if (threadId) payload.threadId = threadId;

    const response = await axios.post(`${GMAIL_API_BASE}/messages/send`, payload, { headers });

    logger.info('Email sent successfully', {
      userId: auth0UserId,
      to,
      messageId: response.data.id,
    });

    return {
      success: true,
      messageId: response.data.id,
      threadId: response.data.threadId,
    };
  } catch (error) {
    logger.error('Failed to send email:', {
      userId: auth0UserId,
      to,
      error: error.response?.data || error.message,
    });
    throw new Error('Failed to send email');
  }
}

/**
 * E-posta sil (çöp kutusuna taşı).
 * HIGH-STAKES ACTION: Step-up Auth gerektirir.
 */
async function trashEmail(auth0UserId, messageId) {
  try {
    const headers = await getGmailHeaders(auth0UserId);

    await axios.post(`${GMAIL_API_BASE}/messages/${messageId}/trash`, {}, { headers });

    logger.info('Email trashed successfully', {
      userId: auth0UserId,
      messageId,
    });

    return { success: true, messageId };
  } catch (error) {
    logger.error('Failed to trash email:', {
      messageId,
      error: error.response?.data || error.message,
    });
    throw new Error('Failed to delete email');
  }
}

/**
 * E-posta etiketlerini güncelle (okundu/okunmadı).
 */
async function modifyLabels(auth0UserId, messageId, { addLabelIds = [], removeLabelIds = [] }) {
  try {
    const headers = await getGmailHeaders(auth0UserId);

    await axios.post(
      `${GMAIL_API_BASE}/messages/${messageId}/modify`,
      { addLabelIds, removeLabelIds },
      { headers }
    );

    return { success: true, messageId };
  } catch (error) {
    logger.error('Failed to modify labels:', {
      messageId,
      error: error.response?.data || error.message,
    });
    throw new Error('Failed to update email');
  }
}

module.exports = {
  listEmails,
  getEmailDetail,
  getEmailBody,
  sendEmail,
  trashEmail,
  modifyLabels,
};
