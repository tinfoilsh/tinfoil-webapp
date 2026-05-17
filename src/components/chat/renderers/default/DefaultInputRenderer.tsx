import { ChatInput } from '../../chat-input'
import type { InputRenderer, InputRenderProps } from '../types'

export const DefaultInputRenderer: InputRenderer = {
  id: 'default',
  canRender: () => true,

  render: (props: InputRenderProps) => {
    // ChatInput expects an (e: FormEvent) => void handler, while
    // InputRenderer.onSubmit takes the message content. Bridge the two and
    // let the parent attach processed documents from its own state.
    const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault()
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
