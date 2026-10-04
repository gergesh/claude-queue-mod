export type QueueItem = { id: string; text: string }

/** A queued prompt steered into the running turn: `pending` until the model's next step reads it. */
export type SteeredItem = { id: string; text: string; status: 'pending' | 'read' }

declare module 'claude-code' {
  interface PluginState {
    'wait-queue': {
      items: QueueItem[]
      editingId: string | null
      isPaused: boolean
      steered: SteeredItem[]
      /** The main loop's running turn, or null while idle. */
      runningTurnId: string | null
      /** True from releasing a queued prompt until its turn starts, so only one goes at a time. */
      isReleasing: boolean
    }
  }
}
