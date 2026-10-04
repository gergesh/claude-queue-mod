export type QueueItem = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'wait-queue': {
      items: QueueItem[]
      editingId: string | null
      isPaused: boolean
    }
  }
}
