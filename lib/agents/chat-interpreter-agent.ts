import { runOpenAIJson, runOpenAIText } from '@/lib/llm/openai'

type ContextBlock = {
  id: string
  repository_id: string
  type: string
  title: string
  description: string
  content: string
  keywords: string[]
}

const INTERPRETER_SYSTEM_PROMPT = `
You are a Chat Interpreter Agent for product intelligence.
Return JSON only with:
{
  "intent": string,
  "keywords": string[]
}
Focus on product and operations language, not code internals.
`.trim()

const ANSWER_SYSTEM_PROMPT = `
You are ProductGPT.
Use ONLY provided context blocks.
Do not expose code, internal implementation, secrets, or inferred internals.
Write clear non-technical product and operational insights.
If confidence is low, start with: "Based on available context, this appears to..."
`.trim()

function fallbackKeywords(question: string) {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .slice(0, 8)
}

export async function interpretQuestion(question: string) {
  const fallback = { intent: 'product_question', keywords: fallbackKeywords(question) }
  const parsed = await runOpenAIJson<{ intent?: string; keywords?: string[] }>(
    INTERPRETER_SYSTEM_PROMPT,
    question,
    fallback
  )
  return {
    intent: parsed.intent || fallback.intent,
    keywords: Array.isArray(parsed.keywords) && parsed.keywords.length > 0
      ? parsed.keywords
      : fallback.keywords,
  }
}

export async function answerWithContext(input: {
  question: string
  contextBlocks: ContextBlock[]
}) {
  const conciseContext = input.contextBlocks
    .slice(0, 15)
    .map((b) => ({
      type: b.type,
      title: b.title,
      description: b.description,
      content: b.content,
      keywords: b.keywords,
    }))

  const userPrompt = `
Question:
${input.question}

Context blocks:
${JSON.stringify(conciseContext, null, 2)}
`.trim()

  const fallback =
    'Based on available context, this appears to involve product behavior that needs additional repository intelligence for a fully confident answer.'

  const answer = await runOpenAIText(ANSWER_SYSTEM_PROMPT, userPrompt, fallback)

  const confidence = Math.max(0.35, Math.min(0.95, input.contextBlocks.length / 10))
  return {
    answer,
    confidence,
    contextBlockIds: input.contextBlocks.map((b) => b.id),
  }
}
