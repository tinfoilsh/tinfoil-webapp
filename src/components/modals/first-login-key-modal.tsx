import { Dialog, Transition } from '@headlessui/react'
import {
  ArrowUpTrayIcon,
  KeyIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { Fragment, useCallback, useRef, useState } from 'react'

interface FirstLoginKeyModalProps {
  isOpen: boolean
  onClose: () => void
  onNewKey: () => void
  onImportKey: (key: string) => Promise<void>
  isDarkMode: boolean
}

export function FirstLoginKeyModal({
  isOpen,
  onClose,
  onNewKey,
  onImportKey,
  isDarkMode,
}: FirstLoginKeyModalProps) {
  void isDarkMode
  const [showImportView, setShowImportView] = useState(false)
  const [inputKey, setInputKey] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const extractKeyFromPEM = (pemContent: string): string | null => {
    const lines = pemContent.split('\n')
    const startIndex = lines.findIndex((line) =>
      line.includes('BEGIN TINFOIL CHAT ENCRYPTION KEY'),
    )
    const endIndex = lines.findIndex((line) =>
      line.includes('END TINFOIL CHAT ENCRYPTION KEY'),
    )

    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
      const keyLines = lines.slice(startIndex + 1, endIndex)
      const keyContent = keyLines.join('').trim()
      return keyContent ? `key_${keyContent}` : null
    }

    return null
  }

  const handleFileImport = useCallback(async (file: File) => {
    try {
      const content = await file.text()
      const extractedKey = extractKeyFromPEM(content)

      if (extractedKey) {
        setInputKey(extractedKey)
        setError(null)
      } else {
        setError('Could not extract encryption key from the PEM file')
      }
    } catch (error) {
      setError('Failed to read the PEM file')
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)

      const files = Array.from(e.dataTransfer.files)
      const pemFile = files.find((file) =>
        file.name.toLowerCase().endsWith('.pem'),
      )

      if (pemFile) {
        await handleFileImport(pemFile)
      } else {
        setError('Please drop a .pem file')
      }
    },
    [handleFileImport],
  )

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      await handleFileImport(file)
    }
  }

  const handleImport = async () => {
    if (!inputKey.trim()) {
      setError('Please enter a valid encryption key')
      return
    }

    setIsImporting(true)
    setError(null)
    try {
      await onImportKey(inputKey)
      onClose()
    } catch (error) {
      setError('The encryption key you entered is invalid')
    } finally {
      setIsImporting(false)
    }
  }

  const handleNewKey = () => {
    onNewKey()
    onClose()
  }

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/50" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl border border-border-subtle bg-surface-card p-6 text-left align-middle shadow-xl transition-all">
                {!showImportView ? (
                  <>
                    <Dialog.Title
                      as="h3"
                      className="flex items-center justify-between text-lg font-medium leading-6 text-content-primary"
                    >
                      <div className="flex items-center gap-2">
                        <KeyIcon className="h-6 w-6 text-content-primary" />
                        <span>Welcome to Tinfoil Chat</span>
                      </div>
                    </Dialog.Title>

                    <div className="mt-4">
                      <p className="text-sm text-content-secondary">
                        Your messages are end-to-end encrypted. Choose how
                        you&apos;d like to set up your encryption:
                      </p>

                      <div className="mt-6 space-y-3">
                        <button
                          onClick={() => setShowImportView(true)}
                          className="w-full rounded-lg border border-border-subtle bg-surface-chat p-4 text-left transition-colors hover:bg-surface-chat/80"
                        >
                          <div className="flex items-start gap-3">
                            <ArrowUpTrayIcon className="mt-0.5 h-5 w-5 text-content-primary" />
                            <div>
                              <h4 className="font-medium text-content-primary">
                                Import Existing Key
                              </h4>
                              <p className="mt-1 text-xs text-content-muted">
                                Sync with your other devices by importing your
                                saved key.
                              </p>
                            </div>
                          </div>
                        </button>

                        <button
                          onClick={handleNewKey}
                          className="w-full rounded-lg border border-brand-accent-dark/40 bg-brand-accent-dark p-4 text-left text-white shadow-md transition-colors hover:bg-brand-accent-dark/90"
                        >
                          <div className="flex items-start gap-3">
                            <SparklesIcon className="mt-0.5 h-5 w-5 text-white" />
                            <div>
                              <h4 className="font-medium text-white">
                                Create New Encryption Key
                              </h4>
                              <p className="mt-1 text-xs text-white/80">
                                Start fresh with a new key.
                              </p>
                            </div>
                          </div>
                        </button>
                      </div>

                      <p className="mt-6 text-xs text-content-muted">
                        You can always access your encryption key later from
                        Settings.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <Dialog.Title
                      as="h3"
                      className="flex items-center justify-between text-lg font-medium leading-6 text-content-primary"
                    >
                      <div className="flex items-center gap-2">
                        <ArrowUpTrayIcon className="h-6 w-6 text-content-primary" />
                        <span>Import Encryption Key</span>
                      </div>
                      <button
                        onClick={() => {
                          setShowImportView(false)
                          setInputKey('')
                          setError(null)
                        }}
                        aria-label="Back"
                        className="rounded-lg p-1 text-content-secondary transition-colors hover:bg-surface-chat"
                      >
                        <XMarkIcon className="h-5 w-5" />
                      </button>
                    </Dialog.Title>

                    <div className="mt-4">
                      <p className="text-sm text-content-secondary">
                        Import your encryption key to sync with your existing
                        chats.
                      </p>

                      {/* Drag and Drop Zone */}
                      <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`mt-4 rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
                          isDragging
                            ? 'border-brand-accent-light bg-brand-accent-light/10'
                            : 'border-border-subtle bg-surface-chat'
                        }`}
                      >
                        <ArrowUpTrayIcon
                          className={`mx-auto h-8 w-8 ${
                            isDragging
                              ? 'text-brand-accent-light'
                              : 'text-content-muted'
                          }`}
                        />
                        <p
                          className={`mt-2 text-xs sm:text-sm ${
                            isDragging
                              ? 'text-brand-accent-light'
                              : 'text-content-muted'
                          }`}
                        >
                          {isDragging
                            ? 'Drop your PEM file here'
                            : 'Drag and drop a PEM file here'}
                        </p>
                        {!isDragging && (
                          <>
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept=".pem"
                              onChange={handleFileSelect}
                              className="hidden"
                            />
                            <button
                              onClick={() => fileInputRef.current?.click()}
                              className="mt-3 rounded-md border border-border-subtle bg-surface-input px-3 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-input/80 sm:text-sm"
                            >
                              Choose File
                            </button>
                          </>
                        )}
                      </div>

                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (!isImporting && inputKey.trim()) {
                            handleImport()
                          }
                        }}
                        className="mt-4"
                        id="encryption-key-form"
                      >
                        <label className="block text-xs font-medium text-content-secondary">
                          Or paste your key directly:
                        </label>
                        <input
                          type="password"
                          name="encryption-key"
                          value={inputKey}
                          onChange={(e) => {
                            setInputKey(e.target.value)
                            setError(null)
                          }}
                          placeholder="Enter encryption key (e.g., key_abc123...)"
                          autoComplete="off"
                          className="mt-1 w-full rounded-lg border border-border-subtle bg-surface-input px-3 py-2 text-sm text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-brand-accent-light"
                        />

                        {error && (
                          <p className="mt-2 text-xs text-destructive">
                            {error}
                          </p>
                        )}

                        <div className="mt-6 flex gap-3">
                          <button
                            type="button"
                            onClick={() => {
                              setShowImportView(false)
                              setInputKey('')
                              setError(null)
                            }}
                            className="flex-1 rounded-lg border border-border-subtle bg-surface-chat px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-surface-chat/80"
                          >
                            Back
                          </button>
                          <button
                            type="submit"
                            disabled={isImporting || !inputKey.trim()}
                            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                              isImporting || !inputKey.trim()
                                ? 'cursor-not-allowed bg-surface-chat text-content-muted'
                                : 'bg-brand-accent-dark text-white hover:bg-brand-accent-dark/90'
                            }`}
                          >
                            {isImporting ? 'Importing...' : 'Import Key'}
                          </button>
                        </div>
                      </form>
                    </div>
                  </>
                )}
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
