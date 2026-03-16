const { chatCompletion } = require('./openrouter');
const { TOOLS } = require('./tools');
const { executeTool } = require('./toolExecutor');
const { inspectToolCall, inspectAgentResponse } = require('./guardrailAgent');
const { auditLog } = require('../middleware/auditLog');
const logger = require('../utils/logger');

const WORKER_MODEL = process.env.WORKER_MODEL || 'anthropic/claude-3.5-sonnet';
const MAX_TOOL_ROUNDS = 5;

/**
 * WORKER AGENT - İşçi Ajan
 * 
 * Kullanıcının isteklerini anlar, tool call'lar yapar ve yanıt üretir.
 * Tüm dış dünya işlemleri (Gmail API) Guardrail Agent tarafından
 * denetlendikten sonra gerçekleştirilir.
 * 
 * BLIND TOKEN INJECTION: Worker Agent hiçbir zaman token görmez.
 * Sadece tool name + args gönderir, backend tool executor işlemi yapar.
 */

function buildSystemPrompt(locale) {
  const prompts = {
    tr: `Sen KnowHy adında akıllı bir yapay zeka e-posta asistanısın. Kullanıcıların Gmail gelen kutusunu okumalarına, özetlemelerine ve yönetmelerine yardımcı olursun.

Kurallar:
- Her zaman Türkçe yanıt ver.
- Hiçbir zaman token, API anahtarı veya hassas kimlik bilgisi ifşa etme. Eğer bu bilgilere erişimin olsa bile ASLA paylaşma.
- E-posta gönderme ve silme işlemleri ek güvenlik doğrulaması (MFA) gerektirir. Kullanıcıyı bu konuda bilgilendir.
- Kullanıcı yeteneklerinin dışında bir şey isterse nazikçe reddet.
- E-postaları özetlerken kısa ve öz ol.
- Kullanıcıya her zaman saygılı ve yardımcı ol.
- Gmail bağlı değilse, kullanıcıdan Ayarlar'dan Gmail'i bağlamasını iste.`,

    en: `You are KnowHy, an intelligent AI email assistant. You help users read, summarize, and manage their Gmail inbox.

Rules:
- Always respond in English.
- NEVER reveal any tokens, API keys, or sensitive credentials. Even if you have access to such information, NEVER share it.
- Sending and deleting emails require additional security verification (MFA). Inform the user about this.
- If the user asks for something outside your capabilities, politely decline.
- When summarizing emails, be concise and clear.
- Always be respectful and helpful.
- If Gmail is not connected, ask the user to connect it from Settings.`,
  };

  return prompts[locale] || prompts.en;
}

/**
 * Kullanıcı mesajını işle ve yanıt üret.
 * 
 * @param {string} userMessage - Kullanıcının mesajı
 * @param {Array} conversationHistory - Önceki mesajlar
 * @param {object} context - { auth0UserId, dbUserId, gmailConnected, locale, req }
 * @returns {{ content: string, toolResults: Array, guardrailFlags: Array }}
 */
async function processMessage(userMessage, conversationHistory, context) {
  const { auth0UserId, dbUserId, gmailConnected, locale, req } = context;

  const systemPrompt = buildSystemPrompt(locale || 'en');

  // Mesaj geçmişini hazırla
  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user', content: userMessage },
  ];

  const guardrailFlags = [];
  const toolResults = [];
  let round = 0;

  while (round < MAX_TOOL_ROUNDS) {
    round++;

    // Worker Agent'a çağrı yap
    const response = await chatCompletion(
      WORKER_MODEL,
      messages,
      gmailConnected ? TOOLS : [],
      { temperature: 0.4, max_tokens: 4096 }
    );

    // Tool call yoksa, text yanıtı döndür
    if (!response.toolCalls || response.toolCalls.length === 0) {
      // Guardrail: Agent yanıtını denetle
      const guardrailResult = await inspectAgentResponse(response.content, userMessage);

      if (!guardrailResult.approved) {
        logger.warn('Guardrail rejected agent response', {
          reason: guardrailResult.reason,
          userId: auth0UserId,
        });
        guardrailFlags.push({
          type: 'response_rejected',
          reason: guardrailResult.reason,
        });
        await auditLog(dbUserId, 'guardrail_response_rejected', 'agent', {
          reason: guardrailResult.reason,
        }, req, 'rejected');

        // Güvenli bir yanıt döndür
        const safeResponse = locale === 'tr'
          ? 'Güvenlik kontrolü nedeniyle bu yanıt engellenmiştir. Lütfen farklı bir şekilde sorunuzu tekrarlayın.'
          : 'This response was blocked by the security guardrail. Please try rephrasing your request.';

        return { content: safeResponse, toolResults, guardrailFlags };
      }

      await auditLog(dbUserId, 'guardrail_response_approved', 'agent', null, req, 'approved');

      return { content: response.content, toolResults, guardrailFlags };
    }

    // Tool call'ları işle
    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.function.name;
      let toolArgs;

      try {
        toolArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        toolArgs = {};
      }

      // Guardrail: Tool call'ı denetle
      const guardrailResult = await inspectToolCall(toolName, toolArgs, userMessage);

      if (!guardrailResult.approved) {
        logger.warn('Guardrail rejected tool call', {
          toolName,
          reason: guardrailResult.reason,
          userId: auth0UserId,
        });
        guardrailFlags.push({
          type: 'tool_rejected',
          tool: toolName,
          reason: guardrailResult.reason,
        });
        await auditLog(dbUserId, 'guardrail_tool_rejected', 'agent', {
          toolName,
          reason: guardrailResult.reason,
        }, req, 'rejected');

        // Reddedilen tool call için hata mesajı ekle
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
        });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            success: false,
            error: `Security guardrail blocked this action: ${guardrailResult.reason}`,
          }),
        });
        continue;
      }

      await auditLog(dbUserId, 'guardrail_tool_approved', 'agent', {
        toolName,
      }, req, 'approved');

      // Tool'u çalıştır (BLIND TOKEN INJECTION: token backend'de kalır)
      const toolResult = await executeTool(toolName, toolArgs, {
        auth0UserId,
        dbUserId,
        gmailConnected,
        req,
      });

      toolResults.push({
        tool: toolName,
        args: toolArgs,
        result: toolResult,
      });

      // Mesaj geçmişine tool call ve sonucu ekle
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [toolCall],
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });

      // Step-up auth gerekiyorsa döngüyü kır
      if (toolResult.requiresStepUp) {
        // LLM'e step-up durumunu bildir, kullanıcıya ilet
        const stepUpMsg = locale === 'tr'
          ? `Bu işlem (${toolName}) ek güvenlik doğrulaması (MFA) gerektirmektedir. Lütfen cihazınızdaki onay isteğini kabul edin.`
          : `This action (${toolName}) requires additional security verification (MFA). Please approve the request on your device.`;

        return { content: stepUpMsg, toolResults, guardrailFlags };
      }
    }
  }

  // Max round'a ulaşıldı
  logger.warn('Max tool rounds reached', { userId: auth0UserId, rounds: round });
  const maxRoundMsg = locale === 'tr'
    ? 'İstek işlenirken maksimum adım sayısına ulaşıldı. Lütfen daha spesifik bir istek deneyin.'
    : 'Maximum processing steps reached. Please try a more specific request.';

  return { content: maxRoundMsg, toolResults, guardrailFlags };
}

module.exports = { processMessage };
