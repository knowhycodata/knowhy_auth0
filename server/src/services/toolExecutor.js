const logger = require('../utils/logger');
const gmailService = require('./gmail');
const { isHighStakesAction } = require('./tools');
const { auditLog } = require('../middleware/auditLog');

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
 * @param {object} context - { auth0UserId, dbUserId, gmailConnected, req }
 * @returns {object} - Tool sonucu (LLM'e gönderilecek)
 */
async function executeTool(toolName, args, context) {
  const { auth0UserId, dbUserId, gmailConnected, req } = context;

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
    await auditLog(dbUserId, `tool_${toolName}_stepup_required`, 'agent', { args }, req);

    return {
      success: false,
      requiresStepUp: true,
      action: toolName,
      message: 'This action requires additional authentication (MFA). Please approve the request on your device.',
      pendingArgs: args,
    };
  }

  try {
    switch (toolName) {
      case 'read_emails':
        return await executeReadEmails(auth0UserId, args, dbUserId, req);

      case 'read_email_detail':
        return await executeReadEmailDetail(auth0UserId, args, dbUserId, req);

      case 'send_email':
        return await executeSendEmail(auth0UserId, args, dbUserId, req);

      case 'delete_email':
        return await executeDeleteEmail(auth0UserId, args, dbUserId, req);

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

async function executeReadEmails(auth0UserId, args, dbUserId, req) {
  const result = await gmailService.listEmails(auth0UserId, {
    maxResults: Math.min(args.maxResults || 10, 20),
    query: args.query || '',
    labelIds: args.labelIds || ['INBOX'],
  });

  await auditLog(dbUserId, 'tool_read_emails', 'agent', {
    emailCount: result.emails.length,
    query: args.query,
  }, req);

  return {
    success: true,
    emailCount: result.emails.length,
    emails: result.emails.map((e) => ({
      id: e.id,
      subject: e.subject,
      from: e.from,
      date: e.date,
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

async function executeDeleteEmail(auth0UserId, args, dbUserId, req) {
  // Bu fonksiyon sadece step-up auth geçtikten sonra çağrılır
  const result = await gmailService.trashEmail(auth0UserId, args.emailId);

  await auditLog(dbUserId, 'tool_delete_email', 'agent', {
    emailId: args.emailId,
  }, req, 'approved');

  return { success: true, messageId: result.messageId };
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
