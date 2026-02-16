const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

function getApiKey() {
  return process.env.OPENAI_API_KEY || ''
}

export class LLMRequestError extends Error {
  kind: 'authorization_fail' | 'service_unavailable' | 'invalid_response'
  constructor(
    kind: 'authorization_fail' | 'service_unavailable' | 'invalid_response',
    message: string
  ) {
    super(message)
    this.kind = kind
  }
}

export async function runOpenAIJson<T>(
  systemPrompt: string,
  userPrompt: string,
  fallback: T
): Promise<T> {
  const apiKey = getApiKey()
  if (!apiKey) return fallback

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    if (!response.ok) return fallback
    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content || typeof content !== 'string') return fallback

    return JSON.parse(content) as T
  } catch (error) {
    console.error('OpenAI JSON request failed:', error)
    return fallback
  }
}

export async function runOpenAIText(
  systemPrompt: string,
  userPrompt: string,
  fallback: string
): Promise<string> {
  const apiKey = getApiKey()
  if (!apiKey) return fallback

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    })

    if (!response.ok) return fallback
    const data = await response.json()
    return data?.choices?.[0]?.message?.content || fallback
  } catch (error) {
    console.error('OpenAI text request failed:', error)
    return fallback
  }
}

export async function runOpenAIJsonOrThrow<T>(
  systemPrompt: string,
  userPrompt: string
): Promise<T> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new LLMRequestError('authorization_fail', 'authorization fail')
  }

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LLMRequestError('authorization_fail', 'authorization fail')
    }
    throw new LLMRequestError(
      'service_unavailable',
      `OpenAI request failed with status ${response.status}`
    )
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new LLMRequestError('invalid_response', 'OpenAI returned invalid response')
  }

  try {
    return JSON.parse(content) as T
  } catch {
    throw new LLMRequestError('invalid_response', 'OpenAI returned non-JSON content')
  }
}
