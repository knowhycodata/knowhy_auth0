const logger = require('../utils/logger');
const gmailService = require('./gmail');
const { isHighStakesAction } = require('./tools');
const { auditLog } = require('../middleware/auditLog');
const { createStepUpChallenge, consumeStepUpChallenge } = require('./stepUpContext');

const AUTOMATED_SENDER_PATTERNS = [
  /mailer-daemon/i,
  /postmaster/i,
  /no-?reply/i,
  /daemon/i,
];

const AUTOMATED_SUBJECT_PATTERNS = [
  /delivery status notification/i,
  /undeliver/i,
  /failure notice/i,
  /mail delivery/i,
  /teslim edilemedi/i,
  /adres bulunamad[iı]/i,
];

function extractEmailAddress(raw = '') {
  const str = String(raw || '').trim();
  const match = str.match(/<([^>]+)>/);
  if (match?.[1]) {
    return match[1].trim().toLowerCase();
  }
  return str.toLowerCase();
}

function isAutomatedNotification(email = {}) {
  const from = String(email.from || '');
  const subject = String(email.subject || '');
  return AUTOMATED_SENDER_PATTERNS.some((p) => p.test(from))
    || AUTOMATED_SUBJECT_PATTERNS.some((p) => p.test(subject));
}

function prioritizeHumanEmails(emails = [], userEmail = '') {
  const selfEmail = extractEmailAddress(userEmail);

  return [...emails].sort((a, b) => {
    const aAutomated = isAutomatedNotification(a);
    const bAutomated = isAutomatedNotification(b);
    if (aAutomated !== bAutomated) {
      return aAutomated ? 1 : -1;
    }

    const aFrom = extractEmailAddress(a.from);
    const bFrom = extractEmailAddress(b.from);
    const aSelf = selfEmail && aFrom === selfEmail;
    const bSelf = selfEmail && bFrom === selfEmail;
    if (aSelf !== bSelf) {
      return aSelf ? 1 : -1;
    }

    return Number(b.internalDate || 0) - Number(a.internalDate || 0);
  });
}

function looksLikeGmailMessageId(value) {
  return /^[a-f0-9]{12,32}$/i.test(String(value || '').trim());
}

/**
 * BLIND TOKEN INJECTION - Tool Executor
 * 
 * LLM sadece JSON tool call gönderir:
 *   { "action": "read_emails", "maxResults": 5 }
 * 
 * Bu executor backend'de token'ı Token Vault'tan çeker,
 * Gmail API'ye istek yapar ve LLM'e sadece sonucu döner.
 * LLM hiçbir zaman token görmez.
 */

/**
 * Tool call'ı çalıştır.
 * @param {string} toolName - Tool adı
 * @param {object} args - Tool parametreleri (LLM'den gelen JSON)
 * @param {object} context - { auth0UserId, dbUserId, userEmail, gmailConnected, stepUpContext, req }
 * @returns {object} - Tool sonucu (LLM'e gönderilecek)
 */
async function executeTool(toolName, args, context) {
  const {
    auth0UserId,
    dbUserId,
    gmailConnected,
    stepUpContext,
    req,
    userEmail,
  } = context;

  logger.info('Executing tool', { toolName, userId: auth0UserId });

  // Gmail bağlantısı kontrolü
  if (!gmailConnected && toolName !== 'summarize_emails') {
    return {
      success: false,
      error: 'Gmail is not connected. Please connect Gmail from Settings first.',
    };
  }

  // HIGH-STAKES ACTION kontrolü
  if (isHighStakesAction(toolName)) {
    const challengeResult = consumeStepUpChallenge({
      challengeId: stepUpContext?.challengeId || null,
      userId: auth0UserId,
      action: toolName,
      authTimestamp: stepUpContext?.authTimestamp,
    });
    const policyApproved = !!stepUpContext
      && (stepUpContext.mfaDetected || !stepUpContext.requireMfaClaim);
    const stepUpApproved = challengeResult.approved && policyApproved;

    if (stepUpApproved) {
      logger.info('Step-up verification satisfied for high-stakes action', {
        toolName,
        userId: auth0UserId,
        authAgeSeconds: stepUpContext?.authAgeSeconds,
        mfaDetected: stepUpContext?.mfaDetected,
        challengeId: stepUpContext?.challengeId || null,
      });
    } else {
      logger.warn('Step-up verification missing/failed for high-stakes action', {
        toolName,
        userId: auth0UserId,
        reason: stepUpContext?.reason || 'stepup_missing',
        challengeReason: challengeResult.reason,
        challengeId: stepUpContext?.challengeId || null,
        authAgeSeconds: stepUpContext?.authAgeSeconds,
        mfaDetected: stepUpContext?.mfaDetected,
      });

      const challenge = createStepUpChallenge({
        userId: auth0UserId,
        action: toolName,
        pendingArgs: args,
      });

      await auditLog(
        dbUserId,
        `tool_${toolName}_stepup_required`,
        'agent',
        {
          args,
          reason: stepUpContext?.reason || 'stepup_missing',
          challengeReason: challengeResult.reason,
          challengeId: challenge.challengeId,
          policyApproved,
          authAgeSeconds: stepUpContext?.authAgeSeconds,
          mfaDetected: stepUpContext?.mfaDetected,
          requireMfaClaim: stepUpContext?.requireMfaClaim,
        },
        req
      );

      return {
        success: false,
        requiresStepUp: true,
        action: toolName,
        message: 'This action requires additional authentication (MFA). Please complete verification in the popup and retry.',
        pendingArgs: args,
        stepUpChallengeId: challenge.challengeId,
        stepUpChallengeExpiresAt: challenge.expiresAt,
      };
    }

    await auditLog(
      dbUserId,
      `tool_${toolName}_stepup_verified`,
      'agent',
      {
        authAgeSeconds: stepUpContext?.authAgeSeconds,
        mfaDetected: stepUpContext?.mfaDetected,
        challengeId: stepUpContext?.challengeId || null,
      },
      req,
      'approved'
    );
  }

  try {
    switch (toolName) {
      case 'read_emails':
        return await executeReadEmails(auth0UserId, args, dbUserId, req, userEmail);

      case 'read_email_detail':
        return await executeReadEmailDetail(auth0UserId, args, dbUserId, req);

      case 'send_email':
        return await executeSendEmail(auth0UserId, args, dbUserId, req);

      case 'delete_email':
        return await executeDeleteEmail(auth0UserId, args, dbUserId, req, userEmail);

      case 'delete_latest_email':
        return await executeDeleteLatestEmail(auth0UserId, dbUserId, req, userEmail);

      case 'summarize_emails':
        return await executeSummarizeEmails(auth0UserId, args, dbUserId, req);

      default:
        logger.warn('Unknown tool called:', toolName);
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    logger.error('Tool execution failed:', { toolName, error: error.message });
    await auditLog(dbUserId, `tool_${toolName}_error`, 'agent', { error: error.message }, req);
    return { success: false, error: error.message };
  }
}

async function executeReadEmails(auth0UserId, args, dbUserId, req, userEmail = '') {
  const result = await gmailService.listEmails(auth0UserId, {
    maxResults: Math.min(args.maxResults || 10, 20),
    query: args.query || '',
    labelIds: args.labelIds || ['INBOX'],
  });

  const shouldPrioritizeHuman =
    (!args.query || String(args.query).trim().length === 0)
    && (!Array.isArray(args.labelIds) || args.labelIds.includes('INBOX'));
  const orderedEmails = shouldPrioritizeHuman
    ? prioritizeHumanEmails(result.emails, userEmail)
    : result.emails;

  await auditLog(dbUserId, 'tool_read_emails', 'agent', {
    emailCount: orderedEmails.length,
    query: args.query,
    prioritizedHuman: shouldPrioritizeHuman,
  }, req);

  return {
    success: true,
    emailCount: orderedEmails.length,
    emails: orderedEmails.map((e) => ({
      id: e.id,
      subject: e.subject,
      from: e.from,
      date: e.date,
      internalDate: e.internalDate || 0,
      isAutomatedNotification: isAutomatedNotification(e),
      snippet: e.snippet,
      isUnread: e.isUnread,
    })),
  };
}

async function executeReadEmailDetail(auth0UserId, args, dbUserId, req) {
  if (!args.messageId) {
    return { success: false, error: 'messageId is required' };
  }

  const result = await gmailService.getEmailBody(auth0UserId, args.messageId);

  await auditLog(dbUserId, 'tool_read_email_detail', 'agent', {
    messageId: args.messageId,
  }, req);

  return {
    success: true,
    email: {
      id: result.id,
      body: result.body,
      snippet: result.snippet,
    },
  };
}

async function executeSendEmail(auth0UserId, args, dbUserId, req) {
  // Bu fonksiyon sadece step-up auth geçtikten sonra çağrılır
  const result = await gmailService.sendEmail(auth0UserId, {
    to: args.to,
    subject: args.subject,
    body: args.body,
    cc: args.cc,
    inReplyTo: args.inReplyTo,
    threadId: args.threadId,
  });

  await auditLog(dbUserId, 'tool_send_email', 'agent', {
    to: args.to,
    subject: args.subject,
    messageId: result.messageId,
  }, req, 'approved');

  return { success: true, messageId: result.messageId };
}

async function executeDeleteEmail(auth0UserId, args, dbUserId, req, userEmail = '') {
  const requestedId = String(args.emailId || '').trim();

  // LLM bazen hayali/bozuk ID üretebiliyor. Bu durumda en güncel maili silme akışına düş.
  if (!looksLikeGmailMessageId(requestedId)) {
    logger.warn('Invalid emailId supplied to delete_email; falling back to delete_latest_email', {
      userId: auth0UserId,
      requestedId,
    });
    return executeDeleteLatestEmail(auth0UserId, dbUserId, req, userEmail);
  }

  try {
    const result = await gmailService.trashEmail(auth0UserId, requestedId);

    await auditLog(dbUserId, 'tool_delete_email', 'agent', {
      emailId: requestedId,
    }, req, 'approved');

    return { success: true, messageId: result.messageId };
  } catch (error) {
    const msg = String(error?.message || '');
    const canFallback = msg.includes('bulunamadı') || msg.includes('ID değeri geçersiz');
    if (canFallback) {
      logger.warn('delete_email failed with stale/invalid id; falling back to delete_latest_email', {
        userId: auth0UserId,
        requestedId,
        error: msg,
      });
      return executeDeleteLatestEmail(auth0UserId, dbUserId, req, userEmail);
    }
    throw error;
  }
}

async function executeDeleteLatestEmail(auth0UserId, dbUserId, req, userEmail = '') {
  const listResult = await gmailService.listEmails(auth0UserId, {
    maxResults: 5,
    query: '',
    labelIds: ['INBOX'],
  });

  const ordered = prioritizeHumanEmails(listResult.emails || [], userEmail);
  const target = ordered[0];

  if (!target?.id) {
    return {
      success: false,
      error: 'Silinecek e-posta bulunamadı. Gelen kutusu boş olabilir.',
    };
  }

  const result = await gmailService.trashEmail(auth0UserId, target.id);

  await auditLog(dbUserId, 'tool_delete_latest_email', 'agent', {
    emailId: target.id,
    from: target.from,
    subject: target.subject,
  }, req, 'approved');

  return {
    success: true,
    messageId: result.messageId,
    deletedEmail: {
      id: target.id,
      from: target.from,
      subject: target.subject,
      date: target.date,
    },
  };
}

async function executeSummarizeEmails(auth0UserId, args, dbUserId, req) {
  // Özetleme için mailleri oku, özetlemeyi LLM yapacak
  const result = await gmailService.listEmails(auth0UserId, {
    maxResults: Math.min(args.maxResults || 10, 20),
    query: args.query || '',
    labelIds: ['INBOX'],
  });

  await auditLog(dbUserId, 'tool_summarize_emails', 'agent', {
    emailCount: result.emails.length,
  }, req);

  return {
    success: true,
    emailCount: result.emails.length,
    emails: result.emails.map((e) => ({
      subject: e.subject,
      from: e.from,
      date: e.date,
      snippet: e.snippet,
      isUnread: e.isUnread,
    })),
  };
}

module.exports = { executeTool };
