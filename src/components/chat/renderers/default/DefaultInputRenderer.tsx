import { ChatInput } from '../../chat-input'
import type { InputRenderer, InputRenderProps } from '../types'

export const DefaultInputRenderer: InputRenderer = {
  id: 'default',
  canRender: () => true,

  render: (props: InputRenderProps) => {
    // Wrap the existing ChatInput component
    // ChatInput expects handleSubmit to be (e: FormEvent) => void
    // but our onSubmit is more complex, so we need to wrap it
    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault()
      // For now, just pass the input text
      // The actual document handling will be done in the parent component
      props.onSubmit(props.input)
    }

    return (
      <ChatInput
        input={props.input}
        setInput={props.setInput}
        handleSubmit={handleSubmit}
        loadingState={props.loadingState}
        cancelGeneration={props.cancelGeneration}
        inputRef={props.inputRef}
        handleInputFocus={props.handleInputFocus}
        inputMinHeight="28px"
        isDarkMode={props.isDarkMode}
        handleDocumentUpload={props.handleDocumentUpload}
        processedDocuments={props.processedDocuments}
        removeDocument={props.removeDocument}
        isPremium={props.isPremium}
        hasMessages={props.hasMessages}
        webSearchEnabled={props.webSearchEnabled}
        onWebSearchToggle={props.onWebSearchToggle}
        codeExecutionEnabled={props.codeExecutionEnabled}
        onCodeExecutionToggle={props.onCodeExecutionToggle}
      />
    )
  },
}
