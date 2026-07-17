import { jsonrepair } from 'jsonrepair';

/**
 * 可配置大模型客户端（OpenAI 兼容 API）
 * 支持：OpenAI / DeepSeek / 通义 / 智谱 / 硅基流动 / 本地 Ollama 等
 */

function getConfig(settings) {
  return {
    baseUrl: (settings.base_url || 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey: settings.api_key || '',
    model: settings.model || 'gpt-4o-mini',
    temperature: Number(settings.temperature ?? 0.85),
    maxTokens: Number(settings.max_tokens ?? 4096),
  };
}

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

function shouldRetry(status) {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chat(messages, settings, options = {}) {
  const cfg = getConfig(settings);
  if (!cfg.apiKey && !cfg.baseUrl.includes('localhost') && !cfg.baseUrl.includes('127.0.0.1')) {
    throw new Error('请先在设置中配置 API Key');
  }

  const body = {
    model: options.model || cfg.model,
    messages,
    temperature: options.temperature ?? cfg.temperature,
    max_tokens: options.maxTokens ?? cfg.maxTokens,
  };

  if (options.stream) body.stream = true;

  let lastError;
  const endpoint = `${cfg.baseUrl}/chat/completions`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let attemptResponse;
    try {
      attemptResponse = await fetch(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeout ?? (options.stream ? 900000 : 600000)),
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error;
    }

    if (attemptResponse) {
      if (!attemptResponse.ok) {
        const text = await attemptResponse.text();
        lastError = new Error(`LLM API 错误 ${attemptResponse.status}: ${text.slice(0, 500)}`);
        if (!shouldRetry(attemptResponse.status)) throw lastError;
      } else {
        const contentType = (attemptResponse.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html')) {
          await attemptResponse.text();
          lastError = new Error(
            `模型接口返回了 HTML 网页而不是 API 数据。请求地址：${endpoint}。请确认接口地址，通常需要以 /v1 结尾`
          );
        } else if (options.stream) {
          if (contentType.includes('text/event-stream')) return attemptResponse;
          const text = await attemptResponse.text();
          lastError = new Error(
            `模型流式接口返回格式错误（${contentType || '未知类型'}）：${text.slice(0, 300)}`
          );
        } else {
          const text = await attemptResponse.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            lastError = new Error(
              `模型接口返回了非 JSON 数据。请求地址：${endpoint}。请确认接口地址和 /v1 路径`
            );
          }
          const content = data?.choices?.[0]?.message?.content;
          if (content) return content;
          if (data) lastError = new Error(`模型返回为空或格式不兼容：${text.slice(0, 300)}`);
        }
      }
    }

    if (attempt < MAX_ATTEMPTS) await wait(800 * 2 ** (attempt - 1));
  }

  throw new Error(`请求重试 ${MAX_ATTEMPTS} 次后仍然失败：${lastError?.message || '未知错误'}`);
}

export async function* chatStream(messages, settings, options = {}) {
  const res = await chat(messages, settings, { ...options, stream: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // ignore partial json
      }
    }
  }
}

export async function chatJSON(messages, settings, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const retryMessages = attempt === 1
      ? messages
      : [
        {
          role: 'system',
          content: `上一次输出不是合法 JSON。这是第 ${attempt} 次尝试，必须输出完整、合法、无截断的 JSON；字符串中的换行必须转义。`,
        },
        ...messages,
      ];
    const text = await chat(retryMessages, settings, options);
    try {
      return extractJSON(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`模型连续 ${MAX_ATTEMPTS} 次返回无效 JSON：${lastError?.message || '未知解析错误'}`);
}

export function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : text.trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('无法从模型输出中解析 JSON');
  const candidate = raw.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (originalError) {
    try {
      return JSON.parse(jsonrepair(candidate));
    } catch {
      throw new Error(`模型 JSON 格式错误：${originalError.message}`);
    }
  }
}

export function extractJSONArray(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : text.trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) {
    // try object with array field
    try {
      return extractJSON(text);
    } catch {
      throw new Error('无法从模型输出中解析 JSON 数组');
    }
  }
  return JSON.parse(raw.slice(start, end + 1));
}
