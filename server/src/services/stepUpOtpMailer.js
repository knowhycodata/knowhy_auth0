const logger = require('../utils/logger');
const { sendEmail } = require('./gmail');

/**
 * Step-up OTP'yi kullanıcının e-posta adresine Gmail API üzerinden gönderir.
 * Token Vault'tan federated token alınır — Blind Token Injection prensibi korunur.
 */
async function sendStepUpOtpEmail(auth0UserId, userEmail, otp, action) {
  const actionLabels = {
    send_email: { tr: 'E-posta Gönderme', en: 'Send Email' },
    delete_email: { tr: 'E-posta Silme', en: 'Delete Email' },
    delete_latest_email: { tr: 'Son E-postayı Silme', en: 'Delete Latest Email' },
  };

  const label = actionLabels[action] || { tr: 'Hassas İşlem', en: 'Sensitive Action' };

  const subject = `Knowhy Güvenlik Kodu / Security Code: ${otp}`;
  const body = [
    `Knowhy AI Asistan — Güvenlik Doğrulama Kodu`,
    `═══════════════════════════════════════════`,
    ``,
    `Doğrulama kodunuz / Your verification code:`,
    ``,
    `    ${otp}`,
    ``,
    `İşlem / Action: ${label.tr} / ${label.en}`,
    ``,
    `Bu kod 5 dakika içinde geçerliliğini yitirecektir.`,
    `This code will expire in 5 minutes.`,
    ``,
    `Bu kodu siz talep etmediyseniz, lütfen dikkate almayın.`,
    `If you did not request this code, please ignore this email.`,
    ``,
    `— Knowhy Security`,
  ].join('\n');

  try {
    const result = await sendEmail(auth0UserId, {
      to: userEmail,
      subject,
      body,
    });

    logger.info('Step-up OTP email sent', {
      userId: auth0UserId,
      userEmail,
      action,
      messageId: result.messageId,
    });

    return { success: true, messageId: result.messageId };
  } catch (error) {
    logger.error('Failed to send step-up OTP email', {
      userId: auth0UserId,
      userEmail,
      action,
      error: error.message,
    });
    throw error;
  }
}

module.exports = { sendStepUpOtpEmail };
