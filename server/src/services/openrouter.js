const axios = require('axios');
const logger = require('../utils/logger');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 90000);
const OPENROUTER_MAX_RETRIES = Number(process.env.OPENROUTER_MAX_RETRIES || 1);

function shouldRetry(error) {
  const status = Number(error.response?.status);
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;

  // axios timeout / network errors
  if (error.code === 'ECONNABORTED' || /timeout/i.test(String(error.message || ''))) return true;
  if (!error.response) return true;

  return false;
}

/**
 * OpenRouter API üzerinden LLM çağrısı yap.
 * Function calling (tool use) destekli.
 *
 * @param {string} model - Kullanılacak model (örn: "anthropic/claude-3.5-sonnet")
 * @param {Array} messages - Mesaj geçmişi
 * @param {Array} tools - Kullanılabilir tool tanımları (function calling)
 * @param {object} options - Ek seçenekler (temperature, max_tokens vs.)
 * @returns {object} - { content, toolCalls, usage }
 */
async function chatCompletion(model, messages, tools = [], options = {}) {
  let lastError;

  for (let attempt = 0; attempt <= OPENROUTER_MAX_RETRIES; attempt += 1) {
    try {
      const payload = {
        model,
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.max_tokens ?? 4096,
        top_p: options.top_p ?? 1,
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = options.tool_choice || 'auto';
      }

      const response = await axios.post(
        `${OPENROUTER_BASE_URL}/chat/completions`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://Knowhy.app',
            'X-Title': 'Knowhy AI Email Assistant',
          },
          timeout: OPENROUTER_TIMEOUT_MS,
        }
      );

      const choice = response.data.choices?.[0];
      if (!choice) {
        throw new Error('No response from OpenRouter');
      }

      const result = {
        content: choice.message?.content || '',
        toolCalls: choice.message?.tool_calls || [],
        finishReason: choice.finish_reason,
        usage: response.data.usage || {},
        model: response.data.model,
      };

      logger.debug('OpenRouter response', {
        model,
        finishReason: result.finishReason,
        toolCallCount: result.toolCalls.length,
        tokens: result.usage,
        attempt,
      });

      return result;
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt >= OPENROUTER_MAX_RETRIES;
      const retryable = shouldRetry(error);

      logger.error('OpenRouter API error:', {
        model,
        status: error.response?.status,
        error: error.response?.data?.error || error.message,
        attempt,
        retryable,
      });

      if (!isLastAttempt && retryable) {
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
        continue;
      }

      if (error.response?.status === 429) {
        throw new Error('AI rate limit exceeded. Please try again in a moment.');
      }
      if (error.response?.status === 402) {
        throw new Error('AI service credits exhausted.');
      }

      throw new Error('AI service temporarily unavailable');
    }
  }

  if (lastError?.response?.status === 429) {
    throw new Error('AI rate limit exceeded. Please try again in a moment.');
  }
  if (lastError?.response?.status === 402) {
    throw new Error('AI service credits exhausted.');
  }
  throw new Error('AI service temporarily unavailable');
}

module.exports = { chatCompletion };
