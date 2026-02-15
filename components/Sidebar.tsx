'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, GitBranch, Lightbulb, Settings } from 'lucide-react'
import clsx from 'clsx'

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Repositories', href: '/repositories', icon: GitBranch },
  { name: 'Insights', href: '/insights', icon: Lightbulb },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <div className="w-64 h-screen bg-[#0f0f0f] border-r border-[#1f1f1f] flex flex-col">
      <div className="p-6 border-b border-[#1f1f1f]">
        <h1 className="text-xl font-semibold text-white">ProductGPT</h1>
        <p className="text-sm text-gray-400 mt-1">AI Product Explainer</p>
      </div>
      
      <nav className="flex-1 p-4 space-y-1">
        {navigation.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon
          
          return (
            <Link
              key={item.name}
              href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-[#1a1a1a] text-white'
                  : 'text-gray-400 hover:bg-[#1a1a1a] hover:text-white'
              )}
            >
              <Icon className="w-5 h-5" />
              {item.name}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
