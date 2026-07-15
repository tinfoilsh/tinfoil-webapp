'use client'

import { cn } from '@/components/ui/utils'
import { getProjectColor } from '@/constants/project-colors'
import { FolderIcon } from '@heroicons/react/24/outline'

interface ProjectModeBannerProps {
  projectName: string
  isDarkMode: boolean
  color?: string
}

export function ProjectModeBanner({
  projectName,
  isDarkMode,
  color,
}: ProjectModeBannerProps) {
  const projectColor = getProjectColor(color)
  const colorStyle = projectColor
    ? {
        borderColor: projectColor.hex,
        backgroundColor: projectColor.hex,
      }
    : undefined

  return (
    <div className="pointer-events-none relative z-10 flex w-full flex-none justify-center md:hidden">
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-2 rounded-t-site-tab border-x border-t px-4 py-1.5 transition-colors',
          projectColor
            ? 'text-gray-900'
            : isDarkMode
              ? 'border-white/10 bg-white/5 text-white/60'
              : 'border-gray-200 bg-gray-50 text-gray-500',
        )}
        style={colorStyle}
      >
        <FolderIcon className="h-3.5 w-3.5" />
        <span className="font-aeonik text-xs font-medium">
          You&apos;re working in the{' '}
          <span className="font-bold">{projectName}</span> project
        </span>
      </div>
    </div>
  )
}
