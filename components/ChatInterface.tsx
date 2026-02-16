'use client'

import { useState, useRef, useEffect } from 'react'
import { Send, Loader2 } from 'lucide-react'
import { ChatMessage } from '@/types'
import { supabase } from '@/lib/supabase'

interface ChatInterfaceProps {
  repositoryId?: string
}

export default function ChatInterface({ repositoryId }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isLoading) return

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: input,
      timestamp: new Date(),
    }

    setMessages(prev => [...prev, userMessage])
    setInput('')
    setIsLoading(true)

    try {
      const { data: authData } = await supabase.auth.getSession()
      const accessToken = authData.session?.access_token

      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          question: input,
          repositoryId,
        }),
      })

      const data = await response.json()
      const fallbackMessage =
        'I could not process your request right now. Based on available context, this appears to need a retry. Please try again in a moment.'

      if (!response.ok) {
        throw new Error(data?.error || data?.message || 'AI request failed')
      }

      const assistantMessage: ChatMessage = {
        id: `msg_${Date.now()}_assistant`,
        role: 'assistant',
        content: typeof data.answer === 'string' && data.answer.trim().length > 0
          ? data.answer
          : fallbackMessage,
        confidence: data.confidence,
        timestamp: new Date(),
      }

      setMessages(prev => [...prev, assistantMessage])
    } catch (error) {
      console.error('Error fetching AI response:', error)
      const errorMessage: ChatMessage = {
        id: `msg_${Date.now()}_error`,
        role: 'assistant',
        content:
          error instanceof Error && error.message.toLowerCase().includes('authorization fail')
            ? 'authorization fail'
            : 'I could not process your request right now. Based on available context, this appears to need a retry.',
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <h3 className="text-lg font-medium text-gray-300 mb-2">
                Ask a product question
              </h3>
              <p className="text-sm text-gray-500">
                Get AI-powered explanations about your product
              </p>
            </div>
          </div>
        )}
        
        {messages.map((message) => (
          <div
            key={message.id}
            className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div
              className={message.role === 'user'
                ? 'bg-[#6366f1] text-white rounded-lg px-4 py-2 max-w-[80%]'
                : 'bg-[#1a1a1a] text-gray-200 rounded-lg px-4 py-2 max-w-[80%] border border-[#1f1f1f]'
              }
            >
              <p className="text-sm whitespace-pre-wrap">{message.content}</p>
              {message.confidence !== undefined && message.role === 'assistant' && (
                <div className="mt-2 pt-2 border-t border-[#1f1f1f]">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">Confidence:</span>
                    <div className="flex-1 h-1.5 bg-[#1f1f1f] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#6366f1] transition-all"
                        style={{ width: `${message.confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-400">
                      {Math.round(message.confidence * 100)}%
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-[#1a1a1a] text-gray-200 rounded-lg px-4 py-2 border border-[#1f1f1f]">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t border-[#1f1f1f] p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a product question..."
            className="flex-1 bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#6366f1] focus:border-transparent"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="bg-[#6366f1] text-white rounded-lg px-4 py-2 hover:bg-[#5856eb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
