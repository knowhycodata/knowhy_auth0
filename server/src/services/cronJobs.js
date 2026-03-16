const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db');
const gmailService = require('./gmail');
const { chatCompletion } = require('./openrouter');

const WORKER_MODEL = process.env.WORKER_MODEL || 'anthropic/claude-3.5-sonnet';

/**
 * ASENKRON OTOMASYON - Gece E-posta Özetleme
 * 
 * Her gece (03:00) Gmail bağlı tüm kullanıcıların
 * son 24 saatlik e-postalarını okur ve özetler.
 * Özetler email_summaries tablosuna kaydedilir.
 */

function initCronJobs() {
  // Her gece 03:00'te çalış
  cron.schedule('0 3 * * *', async () => {
    logger.info('Starting nightly email summary job');
    await runEmailSummaryJob();
  }, {
    timezone: 'Europe/Istanbul',
  });

  logger.info('Cron jobs initialized - Nightly email summary at 03:00 (Europe/Istanbul)');
}

async function runEmailSummaryJob() {
  try {
    // Gmail bağlı tüm kullanıcıları al
    const usersResult = await query(
      `SELECT id, auth0_id, email, locale FROM users WHERE gmail_connected = TRUE`
    );

    if (usersResult.rows.length === 0) {
      logger.info('No users with Gmail connected, skipping summary job');
      return;
    }

    logger.info(`Processing email summaries for ${usersResult.rows.length} users`);

    for (const user of usersResult.rows) {
      try {
        await generateUserSummary(user);
      } catch (error) {
        logger.error('Failed to generate summary for user:', {
          userId: user.id,
          email: user.email,
          error: error.message,
        });
      }
    }

    logger.info('Nightly email summary job completed');
  } catch (error) {
    logger.error('Email summary cron job failed:', error.message);
  }
}

async function generateUserSummary(user) {
  const { id: dbUserId, auth0_id: auth0UserId, locale } = user;

  // Son 24 saatin e-postalarını al
  const emails = await gmailService.listEmails(auth0UserId, {
    maxResults: 20,
    query: 'newer_than:1d',
    labelIds: ['INBOX'],
  });

  if (!emails.emails || emails.emails.length === 0) {
    logger.debug('No new emails for user', { userId: dbUserId });
    return;
  }

  // E-postaları özetle (LLM ile)
  const emailListText = emails.emails.map((e, i) =>
    `${i + 1}. From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}\n   Snippet: ${e.snippet}`
  ).join('\n\n');

  const summaryPrompt = locale === 'tr'
    ? `Aşağıdaki e-postaları kısa ve öz bir şekilde Türkçe olarak özetle. Her e-posta için bir satır yaz. En önemli olanları vurgula.\n\nE-postalar:\n${emailListText}`
    : `Summarize the following emails concisely. Write one line per email. Highlight the most important ones.\n\nEmails:\n${emailListText}`;

  const response = await chatCompletion(
    WORKER_MODEL,
    [
      { role: 'system', content: locale === 'tr' ? 'Sen bir e-posta özetleme asistanısın. Kısa ve öz özetler yaz.' : 'You are an email summarization assistant. Write concise summaries.' },
      { role: 'user', content: summaryPrompt },
    ],
    [],
    { temperature: 0.2, max_tokens: 1024 }
  );

  // Özeti kaydet
  const today = new Date().toISOString().split('T')[0];

  await query(
    `INSERT INTO email_summaries (user_id, summary_date, summary_text, email_count, locale)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, summary_date) DO UPDATE SET
       summary_text = EXCLUDED.summary_text,
       email_count = EXCLUDED.email_count`,
    [dbUserId, today, response.content, emails.emails.length, locale || 'en']
  );

  logger.info('Email summary generated', {
    userId: dbUserId,
    emailCount: emails.emails.length,
    date: today,
  });
}

module.exports = { initCronJobs, runEmailSummaryJob };
