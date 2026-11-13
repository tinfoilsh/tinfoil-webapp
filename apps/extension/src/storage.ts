import type { ChatState } from '@tinfoil/chat-client/reducer'
import type {
  BrowserAccess,
  BrowserResult,
  StoredThread,
} from '@tinfoil/chat-client/types'
import { openDB, unwrap, type DBSchema, type IDBPDatabase } from 'idb'
import { BrowserError } from './browser/errors'

const DATABASE_NAME = 'tinfoil-browser'
const DATABASE_VERSION = 3

export type TaskPhase =
  'idle' | 'running' | 'paused' | 'review' | 'interrupted' | 'completed'
export interface Task {
  id: string
  owner: string
  title: string
  updatedAt: number
  thread?: StoredThread
  state: ChatState
  phase: TaskPhase
  lastPrompt: string
  model: string
  effort: 'low' | 'medium' | 'high'
  confirmActions: boolean
  error?: string
  receipt?: {
    runId: string
    instance: string
    cursor?: number
    browser?: BrowserAccess
  }
}

interface ActionRecord {
  owner: string
  taskId: string
  runId: string
  executionId: string
  status: 'started' | 'finished'
  result?: BrowserResult
}

export type TaskSummary = Pick<
  Task,
  'owner' | 'id' | 'title' | 'updatedAt' | 'phase'
>

interface BrowserDatabase extends DBSchema {
  tasks: {
    key: [string, string]
    value: Task
    indexes: {
      summary: [string, number, string, string, TaskPhase]
    }
  }
  actions: {
    key: [string, string, string]
    value: ActionRecord
    indexes: { task: [string, string] }
  }
}

export class TaskStore {
  private readonly database: Promise<IDBPDatabase<BrowserDatabase>>
  constructor(name = DATABASE_NAME) {
    this.database = openDB<BrowserDatabase>(name, DATABASE_VERSION, {
      blocking: () => {
        void this.database.then((database) => database.close())
      },
      upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          db.createObjectStore('tasks', {
            keyPath: ['owner', 'id'],
          })
          db.createObjectStore('actions', {
            keyPath: ['owner', 'runId', 'executionId'],
          }).createIndex('task', ['owner', 'taskId'])
        }
        if (oldVersion < 2)
          transaction
            .objectStore('tasks')
            .createIndex('summary', [
              'owner',
              'updatedAt',
              'id',
              'title',
              'phase',
            ])
        const tasks = unwrap(transaction.objectStore('tasks'))
        if (oldVersion < 3 && tasks.indexNames.contains('owner'))
          tasks.deleteIndex('owner')
      },
    })
  }
  async list(owner: string): Promise<TaskSummary[]> {
    const summaries: TaskSummary[] = []
    const index = (await this.database)
      .transaction('tasks')
      .store.index('summary')
    const range = IDBKeyRange.bound([owner], [owner, []])
    for (
      let cursor = await index.openKeyCursor(range, 'prev');
      cursor;
      cursor = await cursor.continue()
    ) {
      const [, updatedAt, id, title, phase] = cursor.key
      summaries.push({ owner, id, title, updatedAt, phase })
    }
    return summaries
  }
  async get(owner: string, id: string) {
    return (await this.database).get('tasks', [owner, id])
  }
  async put(task: Task) {
    await (await this.database).put('tasks', task)
  }
  async clearActions(owner: string, taskId: string) {
    const tx = (await this.database).transaction('actions', 'readwrite')
    const keys = await tx.store.index('task').getAllKeys([owner, taskId])
    await Promise.all(keys.map((key) => tx.store.delete(key)))
    await tx.done
  }
  async delete(owner: string, taskId: string) {
    const tx = (await this.database).transaction(
      ['tasks', 'actions'],
      'readwrite',
    )
    const keys = await tx
      .objectStore('actions')
      .index('task')
      .getAllKeys([owner, taskId])
    await Promise.all(keys.map((key) => tx.objectStore('actions').delete(key)))
    await tx.objectStore('tasks').delete([owner, taskId])
    await tx.done
  }
  async action(owner: string, runId: string, executionId: string) {
    return (await this.database).get('actions', [owner, runId, executionId])
  }
  async executeOnce(
    owner: string,
    taskId: string,
    runId: string,
    executionId: string,
    execute: () => Promise<BrowserResult>,
  ): Promise<BrowserResult> {
    const db = await this.database
    const tx = db.transaction('actions', 'readwrite')
    const key: [string, string, string] = [owner, runId, executionId]
    const previous = await tx.store.get(key)
    if (previous) {
      await tx.done
      if (previous.status === 'finished' && previous.result)
        return previous.result
      throw new BrowserError(
        'OUTCOME_UNKNOWN',
        'An interrupted action may have completed. Inspect the page, then send a new instruction; it will not be repeated automatically.',
      )
    }
    const record: ActionRecord = {
      owner,
      taskId,
      runId,
      executionId,
      status: 'started',
    }
    await tx.store.add(record)
    await tx.done
    const result = await execute()
    await db.put('actions', { ...record, status: 'finished', result })
    return result
  }
  async close() {
    ;(await this.database).close()
  }
}
