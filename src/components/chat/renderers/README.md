# Chat Renderer System

This directory contains the modular renderer system for chat messages and inputs, allowing different AI models to have their own custom UI components while maintaining a consistent architecture.

## Architecture Overview

The renderer system uses a **registry pattern** to manage different renderers for various AI models. Each model can have:

- Custom message rendering
- Custom input components
- Model-specific features (thoughts, artifacts, etc.)

## Core Components

### Registry (`registry.tsx`)

- Central registry for all renderers
- Manages message and input renderers
- Provides fallback renderers

### Types (`types.ts`)

- `MessageRenderer`: Interface for message rendering
- `InputRenderer`: Interface for input rendering
- `UIProvider`: Complete UI provider for a model

### Default Renderers (`default/`)

- `DefaultMessageRenderer`: Standard message rendering
- `DefaultInputRenderer`: Standard input component

### Reusable Components (`components/`)

- `ThoughtProcess`: Renders AI thinking process
- `MessageContent`: Renders markdown content
- `DocumentList`: Displays attached documents
- `MessageActions`: Copy button and other actions

## Adding a New Model Renderer (When Needed)

When you need model-specific UI features, you can create custom renderers:

1. Create a message renderer:

```typescript
// src/components/chat/renderers/custom/MyModelRenderer.tsx
export const MyModelRenderer: MessageRenderer = {
  id: 'my-model',
  canRender: (message, model) => model.id.startsWith('my-model'),
  render: (props) => {
    // Custom rendering logic
    // Can reuse components from renderers/components/
    return <div>...</div>
  }
}
```

2. Register the renderer:

```typescript
// In your initialization code
import { getRendererRegistry } from '@/components/chat/renderers/client'
import { MyModelRenderer } from './MyModelRenderer'

const rendererRegistry = getRendererRegistry()
rendererRegistry.registerMessageRenderer(MyModelRenderer)
```

## Usage

### In Chat Components

```typescript
import { useMessageRenderer } from '@/components/chat/hooks/use-message-renderer'

function MyChat({ message, model }) {
  const renderer = useMessageRenderer(message, model)

  return renderer.render({
    message,
    model,
    isDarkMode: true,
    // ... other props
  })
}
```

### Using Chat Messages with Renderers

```typescript
import { ChatMessages } from '@/components/chat/chat-messages'

// ChatMessages automatically uses the renderer system
<ChatMessages
  messages={messages}
  selectedModel={selectedModel}
  models={models}
  isDarkMode={isDarkMode}
  chatId={chatId}
  messagesEndRef={messagesEndRef}
  // ... other required props
/>
```

## Benefits

1. **Modularity**: Each model's UI is independent
2. **Extensibility**: Easy to add new models without touching core code
3. **Maintainability**: Small, focused components
4. **Type Safety**: Full TypeScript support
5. **Backwards Compatible**: Works with existing storage and sync

## Future Model-Specific Features

The renderer system is designed to support model-specific features when needed:

### Potential Features

- **Claude**: Artifacts, Projects, Enhanced thought display
- **GPT**: Tool calling UI, Web search results, DALL-E integration
- **Gemini**: Multi-modal inputs, Code execution
- **Custom Models**: Any specific UI components required

Model-specific renderers can be added incrementally as features are implemented, without modifying the core architecture.
