const { chatCompletion } = require('./openrouter');
const { TOOLS, isHighStakesAction } = require('./tools');
const { executeTool } = require('./toolExecutor');
const { inspectToolCall, inspectAgentResponse } = require('./guardrailAgent');
const { auditLog } = require('../middleware/auditLog');
const logger = require('../utils/logger');

const WORKER_MODEL = process.env.WORKER_MODEL || 'anthropic/claude-3.5-sonnet';
const MAX_TOOL_ROUNDS = 5;
const ENABLE_RESPONSE_GUARDRAIL = process.env.ENABLE_RESPONSE_GUARDRAIL === 'true';

function hasExplicitSendIntent(message = '') {
  const text = String(message || '');
  if (!text) return false;

  const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
  if (!hasEmail) return false;

  return /(mail at|email at|send (an )?email|e-?posta (at|g[öo]nder)|mail g[öo]nder|mesaj g[öo]nder)/i.test(text);
}

function hasExplicitDeleteIntent(message = '') {
  const text = String(message || '');
  if (!text) return false;

  const hasDeleteVerb = /(delete|remove|trash|sil|kald[ıi]r|copa at|ç[öo]pe at)/i.test(text);
  const hasEmailNoun = /(mail|email|e-?posta|mesaj)/i.test(text);
  const hasLatestHint = /(latest|last|most recent|son|en son)/i.test(text);

  return hasDeleteVerb && (hasEmailNoun || hasLatestHint);
}

function resolveForcedToolName(message = '') {
  if (hasExplicitDeleteIntent(message)) {
    // Kullanıcı ID belirtmemiş olsa bile deterministic şekilde "latest" akışına sok.
    return 'delete_latest_email';
  }

  if (hasExplicitSendIntent(message)) {
    return 'send_email';
  }

  return null;
}

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
    tr: `Sen Knowhy adında akıllı bir yapay zeka e-posta asistanısın. Kullanıcıların Gmail gelen kutusunu okumalarına, özetlemelerine ve yönetmelerine yardımcı olursun.

Kurallar:
- Her zaman Türkçe yanıt ver.
- Hiçbir zaman token, API anahtarı veya hassas kimlik bilgisi ifşa etme. Eğer bu bilgilere erişimin olsa bile ASLA paylaşma.
- E-posta gönderme ve silme işlemleri ek güvenlik doğrulaması (MFA) gerektirir. Kullanıcıyı bu konuda bilgilendir.
- Kullanıcı yeteneklerinin dışında bir şey isterse nazikçe reddet.
- E-postaları özetlerken kısa ve öz ol.
- Kullanıcıya her zaman saygılı ve yardımcı ol.
- Gmail bağlı değilse, kullanıcıdan Ayarlar'dan Gmail'i bağlamasını iste.
- Kullanıcı "en son gelen mail" sorarsa mutlaka read_emails aracıyla güncel veriyi çek. Otomatik teslimat/bounce bildirimi çıktıysa bunu açıkça belirt.
- Kullanıcı "mail nedir", "kimden geldi", "içeriği ne" gibi net soru sorarsa kısa formatta sadece şu alanları ver: Gönderen, Konu, Kısa Özet.
- Kullanıcı "maili sil", "son maili sil" gibi ID vermeden silme isterse delete_email yerine delete_latest_email aracını kullan.
- Kullanıcı gönderme veya silme niyetini açıkça belirttiyse yazılı teyit isteme. "Evet, sil", "onaylıyorum" gibi yeni bir sohbet mesajı talep etme.
- Hassas işlemlerde onay metinle değil, sistemin MFA arayüzü ile alınır. Bu nedenle uygun high-stakes aracı doğrudan çağır ve MFA adımını backend/UI akışına bırak.
- Kullanıcı gönderim niyetini açıkça belirttiyse serbest metinle MFA açıklaması yazmak yerine mutlaka send_email aracını çağır.
- Kullanıcı subject belirtmediyse kısa ve nötr bir konu üretip send_email aracına ekle.`,

    en: `You are Knowhy, an intelligent AI email assistant. You help users read, summarize, and manage their Gmail inbox.

Rules:
- Always respond in English.
- NEVER reveal any tokens, API keys, or sensitive credentials. Even if you have access to such information, NEVER share it.
- Sending and deleting emails require additional security verification (MFA). Inform the user about this.
- If the user asks for something outside your capabilities, politely decline.
- When summarizing emails, be concise and clear.
- Always be respectful and helpful.
- If Gmail is not connected, ask the user to connect it from Settings.
- If the user asks for the latest email, always fetch fresh data via read_emails. If it is an automated delivery/bounce notification, state that clearly.
- For direct questions like "what is the email" or "who sent it", answer briefly using only: Sender, Subject, Short Summary.
- If the user asks to delete an email without providing an explicit ID (e.g., "delete the latest email"), prefer delete_latest_email instead of delete_email.
- If the user has already expressed clear intent to send or delete, do not ask for extra typed confirmation. Do not ask the user to reply with "yes", "confirm", or similar text.
- High-stakes approval must happen through the system MFA UI, not through chat text. Call the appropriate high-stakes tool directly and let the backend/UI handle MFA.
- If user clearly asks to send an email, never answer with only explanatory MFA text. You must call send_email.
- If subject is not provided, generate a short neutral subject and pass it to send_email.`,
  };

  return prompts[locale] || prompts.en;
}

function buildStepUpRequiredMessage(toolName, locale) {
  const trMap = {
    send_email: 'E-posta göndermek',
    delete_email: 'E-postayı silmek',
    delete_latest_email: 'Son gelen e-postayı silmek',
  };
  const enMap = {
    send_email: 'Sending the email',
    delete_email: 'Deleting the email',
    delete_latest_email: 'Deleting the latest email',
  };

  if (locale === 'tr') {
    const actionText = trMap[toolName] || 'Bu işlemi tamamlamak';
    return `${actionText} için ek güvenlik onayı gerekiyor. Devam etmek için aşağıdaki "Onaylıyorum" butonuna basın; Auth0 MFA doğrulaması açılacak ve işlem otomatik sürdürülecek.`;
  }

  const actionText = enMap[toolName] || 'Completing this action';
  return `${actionText} requires additional security approval. Click "I Approve" below to open Auth0 MFA, then the action will continue automatically.`;
}

/**
 * Kullanıcı mesajını işle ve yanıt üret.
 * 
 * @param {string} userMessage - Kullanıcının mesajı
 * @param {Array} conversationHistory - Önceki mesajlar
 * @param {object} context - { auth0UserId, dbUserId, userEmail, gmailConnected, locale, stepUpContext, req }
 * @returns {{ content: string, toolResults: Array, guardrailFlags: Array, stepUpRequest?: object }}
 */
async function processMessage(userMessage, conversationHistory, context) {
  const {
    auth0UserId,
    dbUserId,
    userEmail,
    gmailConnected,
    locale,
    stepUpContext,
    req,
  } = context;

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
    let response;
    try {
      const forcedToolName = round === 1 && gmailConnected
        ? resolveForcedToolName(userMessage)
        : null;
      response = await chatCompletion(
        WORKER_MODEL,
        messages,
        gmailConnected ? TOOLS : [],
        {
          temperature: 0.4,
          max_tokens: 4096,
          ...(forcedToolName && {
            tool_choice: {
              type: 'function',
              function: { name: forcedToolName },
            },
          }),
        }
      );
    } catch (error) {
      logger.error('Worker model call failed', {
        userId: auth0UserId,
        model: WORKER_MODEL,
        error: error.message,
      });

      const fallbackMsg = locale === 'tr'
        ? 'Yapay zeka servisi su anda yogun veya gecici olarak ulasilamiyor. Lutfen 15-30 saniye sonra tekrar deneyin.'
        : 'The AI service is currently busy or temporarily unavailable. Please retry in 15-30 seconds.';

      return { content: fallbackMsg, toolResults, guardrailFlags };
    }

    // Tool call yoksa, text yanıtı döndür
    if (!response.toolCalls || response.toolCalls.length === 0) {
      // Normal sohbet yanıtlarında güvenlik friksiyonunu azaltmak için varsayılan olarak
      // response-level guardrail kapalıdır. İstenirse ENV ile yeniden açılabilir.
      if (ENABLE_RESPONSE_GUARDRAIL) {
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
      }

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

      // Guardrail sadece high-stakes tool call'lar için zorunlu.
      if (isHighStakesAction(toolName)) {
        const guardrailResult = await inspectToolCall(toolName, toolArgs, userMessage);

        if (!guardrailResult.approved) {
          logger.warn('Guardrail rejected high-stakes tool call', {
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
      }

      // Tool'u çalıştır (BLIND TOKEN INJECTION: token backend'de kalır)
      const toolResult = await executeTool(toolName, toolArgs, {
        auth0UserId,
        dbUserId,
        userEmail,
        gmailConnected,
        stepUpContext,
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
        const stepUpMsg = buildStepUpRequiredMessage(toolName, locale);

        return {
          content: stepUpMsg,
          toolResults,
          guardrailFlags,
          stepUpRequest: {
            required: true,
            action: toolName,
            pendingArgs: toolResult.pendingArgs || toolArgs,
            challengeId: toolResult.stepUpChallengeId || null,
            expiresAt: toolResult.stepUpChallengeExpiresAt || null,
            message: stepUpMsg,
          },
        };
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
