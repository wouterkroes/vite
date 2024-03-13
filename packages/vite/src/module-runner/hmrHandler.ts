import type { HMRPayload } from 'types/hmrPayload'
import { slash, unwrapId } from '../shared/utils'
import type { ModuleRunner } from './runner'

// updates to HMR should go one after another. It is possible to trigger another update during the invalidation for example.
export function createHMRHandler(
  runner: ModuleRunner,
): (payload: HMRPayload) => Promise<void> {
  const queue = new Queue()
  return (payload) => queue.enqueue(() => handleHMRPayload(runner, payload))
}

export async function handleHMRPayload(
  runner: ModuleRunner,
  payload: HMRPayload,
): Promise<void> {
  const hmrClient = runner.hmrClient
  if (!hmrClient || runner.isDestroyed()) return
  switch (payload.type) {
    case 'connected':
      hmrClient.logger.debug(`[vite] connected.`)
      hmrClient.messenger.flush()
      break
    case 'update':
      await hmrClient.notifyListeners('vite:beforeUpdate', payload)
      await Promise.all(
        payload.updates.map(async (update): Promise<void> => {
          if (update.type === 'js-update') {
            // runner always caches modules by their full path without /@id/ prefix
            update.acceptedPath = unwrapId(update.acceptedPath)
            update.path = unwrapId(update.path)
            return hmrClient.queueUpdate(update)
          }

          hmrClient.logger.error(
            '[vite] css hmr is not supported in runner mode.',
          )
        }),
      )
      await hmrClient.notifyListeners('vite:afterUpdate', payload)
      break
    case 'custom': {
      await hmrClient.notifyListeners(payload.event, payload.data)
      break
    }
    case 'full-reload': {
      const { triggeredBy } = payload
      const clearEntrypoints = triggeredBy
        ? getModulesEntrypoints(
            runner,
            getModulesByFile(runner, slash(triggeredBy)),
          )
        : findAllEntrypoints(runner)

      if (!clearEntrypoints.size) break

      hmrClient.logger.debug(`[vite] program reload`)
      await hmrClient.notifyListeners('vite:beforeFullReload', payload)
      runner.moduleCache.clear()

      for (const id of clearEntrypoints) {
        await runner.import(id)
      }
      break
    }
    case 'prune':
      await hmrClient.notifyListeners('vite:beforePrune', payload)
      await hmrClient.prunePaths(payload.paths)
      break
    case 'error': {
      await hmrClient.notifyListeners('vite:error', payload)
      const err = payload.err
      hmrClient.logger.error(
        `[vite] Internal Server Error\n${err.message}\n${err.stack}`,
      )
      break
    }
    default: {
      const check: never = payload
      return check
    }
  }
}

class Queue {
  private queue: {
    promise: () => Promise<void>
    resolve: (value?: unknown) => void
    reject: (err?: unknown) => void
  }[] = []
  private pending = false

  enqueue(promise: () => Promise<void>) {
    return new Promise<any>((resolve, reject) => {
      this.queue.push({
        promise,
        resolve,
        reject,
      })
      this.dequeue()
    })
  }

  dequeue() {
    if (this.pending) {
      return false
    }
    const item = this.queue.shift()
    if (!item) {
      return false
    }
    this.pending = true
    item
      .promise()
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        this.pending = false
        this.dequeue()
      })
    return true
  }
}

function getModulesByFile(runner: ModuleRunner, file: string) {
  const modules: string[] = []
  for (const [id, mod] of runner.moduleCache.entries()) {
    if (mod.meta && 'file' in mod.meta && mod.meta.file === file) {
      modules.push(id)
    }
  }
  return modules
}

function getModulesEntrypoints(
  runner: ModuleRunner,
  modules: string[],
  visited = new Set<string>(),
  entrypoints = new Set<string>(),
) {
  for (const moduleId of modules) {
    if (visited.has(moduleId)) continue
    visited.add(moduleId)
    const module = runner.moduleCache.getByModuleId(moduleId)
    if (module.importers && !module.importers.size) {
      entrypoints.add(moduleId)
      continue
    }
    for (const importer of module.importers || []) {
      getModulesEntrypoints(runner, [importer], visited, entrypoints)
    }
  }
  return entrypoints
}

function findAllEntrypoints(
  runner: ModuleRunner,
  entrypoints = new Set<string>(),
): Set<string> {
  for (const [id, mod] of runner.moduleCache.entries()) {
    if (mod.importers && !mod.importers.size) {
      entrypoints.add(id)
    }
  }
  return entrypoints
}
